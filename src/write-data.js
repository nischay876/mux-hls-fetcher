/* eslint-disable no-console */
const Promise = require('bluebird');
const mkdirp = require('mkdirp');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const fs = Promise.promisifyAll(require('fs'));
const AesDecrypter = require('aes-decrypter').Decrypter;
const path = require('path');

// Configure axios retry
axiosRetry(axios, { 
  retries: 3,
  retryDelay: (retryCount) => {
    return retryCount * 500;
  },
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ECONNABORTED';
  }
});

const writeFile = function(file, content) {
  return mkdirp(path.dirname(file)).then(function() {
    return fs.writeFileAsync(file, content);
  }).then(function() {
    // Removed individual file completion logs for better performance
  });
};

const requestFile = function(uri) {
  return axios({
    url: uri,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000
  }).then(function(response) {
    return Buffer.from(response.data);
  });
};

const toUint8Array = function(nodeBuffer) {
  return new Uint8Array(nodeBuffer.buffer, nodeBuffer.byteOffset, nodeBuffer.byteLength / Uint8Array.BYTES_PER_ELEMENT);
};

const decryptFile = function(content, encryption) {
  return new Promise(function(resolve, reject) {
    /* eslint-disable no-new */
    // this is how you use it, its kind of bad but :shrug:
    new AesDecrypter(toUint8Array(content), encryption.bytes, encryption.iv, function(err, bytes) {
      if (err) {
        return reject(err);
      }
      return resolve(Buffer.from(bytes));
    });
    /* eslint-enable no-new */
  });
};

const WriteData = function(decrypt, concurrency, resources) {
  const inProgress = [];
  const operations = [];
  let completed = 0;
  const total = resources.length;

  // Show progress every 10%
  const progressInterval = Math.max(1, Math.floor(total / 10));
  
  console.log(`🚀 Starting download of ${total} resources with concurrency ${concurrency}`);

  resources.forEach(function(r) {
    if (r.content) {
      operations.push(function() {
        return writeFile(r.file, r.content).then(() => {
          completed++;
          if (completed % progressInterval === 0 || completed === total) {
            console.log(`📊 Progress: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
          }
        });
      });
    } else if (r.uri && r.key && decrypt) {
      operations.push(function() {
        return requestFile(r.uri).then(function(content) {
          return decryptFile(content, r.key);
        }).then(function(content) {
          return writeFile(r.file, content);
        }).then(() => {
          completed++;
          if (completed % progressInterval === 0 || completed === total) {
            console.log(`📊 Progress: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
          }
        });
      });
    } else if (r.uri && inProgress.indexOf(r.uri) === -1) {
      operations.push(function() {
        return requestFile(r.uri).then(function(content) {
          return writeFile(r.file, content);
        }).then(() => {
          completed++;
          if (completed % progressInterval === 0 || completed === total) {
            console.log(`📊 Progress: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
          }
        });
      });
      inProgress.push(r.uri);
    }
  });

  return Promise.map(operations, function(o) {
    return o();
  }, {concurrency}).then(function() {
    console.log(`🎉 Download completed! Successfully processed ${total} resources.`);
    return Promise.resolve();
  }).catch(function(error) {
    console.error(`💥 Download failed with error:`, error);
    throw error;
  });
};

module.exports = WriteData;
