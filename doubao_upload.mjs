/**
 * 参考图上传 —— 纯 HTTP（不依赖浏览器）
 *
 * 链路（2026-11-14 实测，逐跳抓包确认）：
 *   1. POST /alice/resource/prepare_upload   → 拿 STS 临时密钥（access_key / secret_key / session_token）
 *   2. GET  /top/v1?Action=ApplyImageUpload  → AWS4-HMAC-SHA256 签名，拿 StoreUri + Auth(上传令牌)
 *   3. POST https://tos-*.snssdk.com/upload/v1/<StoreUri>  → 传二进制（带 content-crc32）
 *   4. POST /top/v1?Action=CommitImageUpload → 提交，返回最终 Uri
 *
 * 之后把这个 Uri 放进 /chat/completion 的 messages[0].content_block 里
 * block_type=10052 的 attachment_block，即可作为参考图。
 *
 * 上限：一次最多 10 张（传更多服务端只收前 10 张，_probe_refcap 实测）
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://www.doubao.com';
const MAX_REF_IMAGES = 10;

// ── CRC32（TOS 上传要求 content-crc32）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ -1) >>> 0).toString(16).padStart(8, '0');
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();

/**
 * 把任意文件名转成 ASCII 安全名。
 * HTTP 头（content-disposition）只接受 ByteString，中文字符（如 参 = U+53C2）
 * 会抛 "Cannot convert argument to a ByteString"。空格也一并去掉。
 */
function safeAsciiName(origName, extRaw) {
  const base = origName.slice(0, origName.length - (path.extname(origName).length || 0));
  const ascii = base
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '') // 丢掉所有非 ASCII
    .replace(/[^A-Za-z0-9._-]+/g, '_') // 其余非法字符变下划线
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  // 全中文文件名会被清空 → 用内容哈希兜底，保证多张图不重名
  const stem = ascii || `ref_${createHash('sha1').update(origName).digest('hex').slice(0, 10)}`;
  return `${stem}${extRaw}`;
}

/**
 * @param {object} p
 * @param {string[]} p.files            本地图片路径
 * @param {string}   p.cookie           cookie 字符串
 * @param {string}   p.ua               User-Agent
 * @param {Function} p.buildQuery       生成公共 query 的函数
 * @param {Function} p.headers          通用请求头函数
 * @returns {Promise<Array<{name,uri,width,height}>>}
 */
export async function uploadRefImages({ files, buildQuery, headers }) {
  const list = files.slice(0, MAX_REF_IMAGES);
  if (!list.length) return [];

  // ── 1. prepare_upload
  const prepUrl = `${BASE}/alice/resource/prepare_upload?${buildQuery()}`;
  const prepResp = await fetch(prepUrl, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ tenant_id: '5', scene_id: '5', resource_type: 2 }),
  });
  const prep = await prepResp.json();
  if (prep.code !== 0) throw new Error(`prepare_upload 失败：${JSON.stringify(prep).slice(0, 200)}`);
  const d = prep.data;
  const tok = d.upload_auth_token;
  const uploadHost = d.upload_host;
  const SERVICE = d.service_id;
  const REGION = 'cn-north-1';

  const out = [];

  for (const file of list) {
    const buf = await readFile(file);
    const origName = path.basename(file);
    const extRaw = path.extname(origName).toLowerCase() || '.png';
    const ext = extRaw.replace('.', '');
    // HTTP 头只能放 ByteString（≤0xFF）：中文/空格文件名会让 content-disposition 直接抛错。
    // 这里统一换成 ASCII 安全名，原始文件名只用于本地识别（不影响生成效果）。
    const name = safeAsciiName(origName, extRaw);

    // ── 2. ApplyImageUpload（AWS4 签名）
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const credScope = `${dateStamp}/${REGION}/imagex/aws4_request`;
    const awsPath = '/';
    const qp = [
      ['Action', 'ApplyImageUpload'],
      ['Version', '2018-08-01'],
      ['ServiceId', SERVICE],
      ['NeedFallback', 'true'],
      ['FileSize', String(buf.length)],
      ['FileExtension', extRaw],
    ];
    const canonicalQuery = qp
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .sort()
      .join('&');
    const signedHeaders = 'x-amz-date;x-amz-security-token';
    const canonicalHeaders = `x-amz-date:${amzDate}\nx-amz-security-token:${tok.session_token}\n`;
    const canonicalRequest = ['GET', awsPath, canonicalQuery, canonicalHeaders, signedHeaders, sha256Hex('')].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${tok.secret_key}`, dateStamp);
    const kRegion = hmac(kDate, REGION);
    const kService = hmac(kRegion, 'imagex');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${tok.access_key}/${credScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const applyResp = await fetch(`https://${uploadHost}${awsPath}?${canonicalQuery}`, {
      headers: { 'x-amz-date': amzDate, 'x-amz-security-token': tok.session_token, authorization },
    });
    const apply = await applyResp.json();
    const addr = apply?.Result?.UploadAddress;
    const info = addr?.StoreInfos?.[0];
    if (!info) throw new Error(`ApplyImageUpload 失败：${JSON.stringify(apply).slice(0, 300)}`);
    const storeUri = info.StoreUri;
    const auth = info.Auth;
    const uploadID = info.UploadID || '';
    const uploadHosts = addr.UploadHosts || [];

    // ── 3. 传二进制
    let uploaded = false;
    let lastErr = '';
    const hosts = [...uploadHosts, 'tos-d-x-lf.snssdk.com'];
    for (const h of hosts) {
      try {
        const r = await fetch(`https://${h}/upload/v1/${storeUri}`, {
          method: 'POST',
          headers: {
            authorization: auth,
            'content-crc32': crc32(buf),
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${name}"`,
          },
          body: buf,
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && (j.code === 2000 || j.data)) {
          uploaded = true;
          break;
        }
        lastErr = `HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`;
      } catch (e) {
        lastErr = String(e.message || e);
      }
    }
    if (!uploaded) throw new Error(`上传二进制失败：${lastErr}`);

    // ── 4. CommitImageUpload
    //   浏览器发的是一个 base64 的 SessionKey，内容是 {
    //     accountType:'ImageX', fileType:'image', storeInfos:'[<StoreInfo 的 JSON>]',
    //     uploadHost, uri, ... }
    //   直接照抄这个形态，否则服务端报 604033 Upload internal error
    const sessionKey = Buffer.from(
      JSON.stringify({
        accountType: 'ImageX',
        appId: '',
        bizType: '',
        fileType: 'image',
        legal: '',
        storeInfos: JSON.stringify([
          {
            StoreUri: storeUri,
            Auth: auth,
            UploadID: uploadID,
            BatchID: apply?.Result?.RequestId || '',
            UploadHeader: null,
            StorageHeader: null,
          },
        ]),
        uploadHost: uploadHosts[0] || 'tos-hl-x.snssdk.com',
        uri: storeUri,
        useBizTypeBucketConfig: '',
        userId: '',
      }),
    ).toString('base64');
    const body4 = JSON.stringify({ SessionKey: sessionKey });
    const amzDate2 = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp2 = amzDate2.slice(0, 8);
    const credScope2 = `${dateStamp2}/${REGION}/imagex/aws4_request`;
    const payloadHash = sha256Hex(body4);
    const qp2 = [['Action', 'CommitImageUpload'], ['Version', '2018-08-01'], ['ServiceId', SERVICE]];
    const canonicalQuery2 = qp2.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join('&');
    const signedHeaders2 = 'x-amz-content-sha256;x-amz-date;x-amz-security-token';
    const canonicalHeaders2 =
      `x-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate2}\nx-amz-security-token:${tok.session_token}\n`;
    const canonicalRequest2 = ['POST', awsPath, canonicalQuery2, canonicalHeaders2, signedHeaders2, payloadHash].join('\n');
    const sts2 = ['AWS4-HMAC-SHA256', amzDate2, credScope2, sha256Hex(canonicalRequest2)].join('\n');
    const kD2 = hmac(`AWS4${tok.secret_key}`, dateStamp2);
    const kR2 = hmac(kD2, REGION);
    const kS2 = hmac(kR2, 'imagex');
    const kX2 = hmac(kS2, 'aws4_request');
    const sig2 = createHmac('sha256', kX2).update(sts2).digest('hex');
    const auth2 = `AWS4-HMAC-SHA256 Credential=${tok.access_key}/${credScope2}, SignedHeaders=${signedHeaders2}, Signature=${sig2}`;

    const commitResp = await fetch(`https://${uploadHost}${awsPath}?${canonicalQuery2}`, {
      method: 'POST',
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate2,
        'x-amz-security-token': tok.session_token,
        authorization: auth2,
        'content-type': 'application/json',
      },
      body: body4,
    });
    const commit = await commitResp.json();
    const res0 = commit?.Result?.Results?.[0];
    if (!res0 || res0.UriStatus !== 2000) {
      throw new Error(`CommitImageUpload 失败：${JSON.stringify(commit).slice(0, 300)}`);
    }
    const plugin = commit?.Result?.PluginResult?.[0] || {};
    out.push({
      name,
      uri: res0.Uri,
      width: plugin.ImageWidth || plugin.Width || 0,
      height: plugin.ImageHeight || plugin.Height || 0,
    });
  }

  return out;
}

/**
 * 把已上传的参考图拼成 /chat/completion 的 attachment content_block
 * 结构直接取自网页真实请求（block_type=10052）
 */
export function buildAttachmentBlock(uploaded) {
  return {
    block_type: 10052,
    content: {
      attachment_block: {
        attachments: uploaded.map((u) => ({
          type: 1,
          identifier: crypto.randomUUID(),
          image: {
            name: u.name,
            uri: u.uri,
            image_ori: { url: '', width: u.width || 0, height: u.height || 0, format: '', url_formats: {} },
          },
          parse_state: 0,
          review_state: 1,
          upload_status: 1,
          progress: 100,
          src: '',
        })),
      },
      pc_event_block: '',
    },
    block_id: crypto.randomUUID(),
    parent_id: '',
    meta_info: [],
    extra_info: {},
    append_fields: [],
  };
}

export { MAX_REF_IMAGES };