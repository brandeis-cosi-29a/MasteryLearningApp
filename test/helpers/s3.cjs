const {S3Client} = require('@aws-sdk/client-s3');
const {Readable} = require('node:stream');

// Keep the actual SDK serialization, signing, checksum and multipart code in
// upload tests. Only the HTTP transport is replaced; it can never reach AWS.
function storage(options = {}) {
  const uploads = [], imageReads = [], deletes = [], requests = [], clientConfigs = [];
  const imageObjects = new Map(), multipart = new Map();
  const response = (body = '', headers = {}, statusCode = 200) => ({
    statusCode, headers, body: Readable.from([body]),
  });
  async function bytes(body) {
    if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body);
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  const requestHandler = {
    async handle(request) {
      const key = decodeURIComponent(request.path.slice(1));
      const {method, query, headers, hostname} = request;
      requests.push({method, key, query, headers, hostname});
      const override = await options.s3Response?.(request);
      if (override) return {response: override};
      if (method === 'GET' && 'publicAccessBlock' in query) {
        return {response: response('<PublicAccessBlockConfiguration>' +
          ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']
            .map(flag => `<${flag}>true</${flag}>`).join('') + '</PublicAccessBlockConfiguration>')};
      }
      if (method === 'POST' && 'uploads' in query) {
        const uploadId = `synthetic-${multipart.size + 1}`;
        multipart.set(uploadId, new Map());
        return {response: response(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`)};
      }
      if (method === 'PUT') {
        const body = await bytes(request.body);
        if (query.uploadId) multipart.get(query.uploadId).set(Number(query.partNumber), body);
        else {imageObjects.set(key, body); uploads.push(key);}
        return {response: response('', {etag: '"synthetic-etag"'})};
      }
      if (method === 'POST' && query.uploadId) {
        const parts = multipart.get(query.uploadId);
        const body = Buffer.concat([...parts].sort(([a], [b]) => a - b).map(([, part]) => part));
        imageObjects.set(key, body); uploads.push(key); multipart.delete(query.uploadId);
        return {response: response('<CompleteMultipartUploadResult><ETag>"synthetic-etag"</ETag>' +
          `<Location>https://${hostname}${request.path}</Location></CompleteMultipartUploadResult>`)};
      }
      if (method === 'DELETE') {
        if (query.uploadId) multipart.delete(query.uploadId);
        else {imageObjects.delete(key); deletes.push(key);}
        return {response: response('', {}, 204)};
      }
      if (method === 'GET') {
        imageReads.push(key);
        return {response: response(imageObjects.get(key) || Buffer.from('synthetic image bytes'))};
      }
      throw Error(`Unexpected synthetic S3 request: ${method} ${request.path}`);
    },
  };
  class TestS3Client extends S3Client {
    constructor(config) {
      clientConfigs.push(config);
      super({...config, credentials: {accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret'},
        maxAttempts: 1, requestHandler});
    }
  }
  return {S3Client: TestS3Client, uploads, imageReads, imageObjects, deletes, requests, clientConfigs, multipart};
}

module.exports = {storage};
