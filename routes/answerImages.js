const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const createError = require('http-errors');
const {authorize, hasCourseAccess} = require('./authFunctions');
const {canReadAnswer, canBrowseAnswers} = require('./recordAccess');
const {objectKey, localImagePath} = require('../config/answerStorage');

module.exports = function answerImages({s3, env, localRoot}) {
  const router = express.Router();
  router.get('/answerImage/:courseId/:answerId', authorize, hasCourseAccess, async (req, res, next) => {
    try {
      const answer = req.courseScope.answer;
      if (!await canReadAnswer(req, res, answer) && !await canBrowseAnswers(req, res)) throw createError(403);
      if (!answer.imageFilePath) throw createError(404);
      let stream;
      let filename;
      if (env.UPLOAD_TO === 'AWS') {
        const key = objectKey(answer.imageFilePath, env);
        filename = key;
        stream = s3.getObject({Bucket: env.AWS_BUCKET_NAME, Key: key}).createReadStream();
      } else {
        filename = localImagePath(answer.imageFilePath, localRoot);
        stream = fs.createReadStream(filename);
      }
      const types = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.avif': 'image/avif'};
      res.set({
        'Content-Type': types[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      });
      stream.on('error', () => {
        if (res.headersSent) res.destroy();
        else next(createError(404, 'Answer image is unavailable.'));
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (err) {next(err.status ? err : createError(404, 'Answer image is unavailable.'));}
  });
  return router;
};
