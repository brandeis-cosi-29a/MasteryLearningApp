const path = require('node:path');
const PRIVATE_FLAGS = ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'];

function validateStorageConfig(env) {
  if (env.UPLOAD_TO === 'AWS') {
    if (!env.AWS_BUCKET_NAME || !env.AWS_REGION) throw Error('AWS answer storage requires AWS_BUCKET_NAME and AWS_REGION.');
    return;
  }
  if (env.UPLOAD_TO === 'LOCAL' && env.ALLOW_LOCAL_ANSWER_STORAGE === 'true' &&
      ['test', 'development'].includes(env.NODE_ENV)) return;
  throw Error('Answer storage must use AWS. LOCAL requires an explicit non-production testbed configuration.');
}

async function verifyPrivateBucket(s3, env) {
  validateStorageConfig(env);
  if (env.UPLOAD_TO === 'LOCAL') return;
  // Require bucket-level protection, including controls that override pre-existing
  // public ACLs/policies. A missing permission/configuration fails startup closed.
  const result = await s3.getPublicAccessBlock({Bucket: env.AWS_BUCKET_NAME}).promise();
  if (!PRIVATE_FLAGS.every(flag => result.PublicAccessBlockConfiguration?.[flag] === true)) {
    throw Error('Answer-image bucket must enable all four S3 Block Public Access settings.');
  }
}

function objectKey(imagePath, env) {
  const url = new URL(imagePath);
  const allowed = [`${env.AWS_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com`,
    `${env.AWS_BUCKET_NAME}.s3.amazonaws.com`, `${env.AWS_BUCKET_NAME}.s3-${env.AWS_REGION}.amazonaws.com`];
  if (url.protocol !== 'https:' || !allowed.includes(url.host) || url.username || url.password || url.search || url.hash) {
    throw Error('Unrecognized answer-image location.');
  }
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!key.startsWith('studentImages/') || key.includes('\\') || key.includes('\0') ||
      key.split('/').some(segment => segment === '.' || segment === '..' || segment === '')) {
    throw Error('Invalid answer-image key.');
  }
  return key;
}

function localImagePath(imagePath, root) {
  const filename = imagePath.startsWith('local:') ? imagePath.slice(6) : imagePath.replace(/^\/answerImages\//, '');
  if (!/^[a-f\d]{24}_[a-f\d]{24}_\d+_\.[a-z\d]+$/i.test(filename)) throw Error('Invalid testbed answer-image path.');
  return path.join(root, filename);
}

function answerImageUrl(answer) {
  return `/answerImage/${answer.courseId}/${answer._id}`;
}

module.exports = {PRIVATE_FLAGS, validateStorageConfig, verifyPrivateBucket, objectKey, localImagePath, answerImageUrl};
