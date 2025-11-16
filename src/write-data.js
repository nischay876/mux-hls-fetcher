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

const writeFile = async function(file, content) {
  // Handle mkdirp v3+ API properly
  await mkdirp(path.dirname(file));
  return fs.writeFileAsync(file, content);
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

const renameRootManifest = async function(resources, outputPath) {
  // Find the resource that is likely the root manifest (no parent and has content)
  const rootResources = resources.filter(r => 
    r.file && 
    !r.parent && 
    path.basename(r.file) !== 'master.m3u8' &&
    (r.content || r.uri)
  );
  
  for (const rootResource of rootResources) {
    const oldPath = rootResource.file;
    const newPath = path.join(path.dirname(oldPath), 'master.m3u8');
    
    // Check if file exists before trying to rename
    try {
      if (fs.existsSync(oldPath)) {
        await fs.renameAsync(oldPath, newPath);
        rootResource.file = newPath;
        console.log(`🔄 Renamed root manifest to: master.m3u8`);
        break; // Only rename the first one found
      }
    } catch (err) {
      console.warn(`⚠️  Could not rename root manifest: ${err.message}`);
    }
  }
};

const WriteData = function(decrypt, concurrency, resources, outputPath) {
  const inProgress = [];
  const operations = [];
  let completed = 0;
  const total = resources.length;

  // Show progress every 10%
  const progressInterval = Math.max(1, Math.floor(total / 10));
  
  console.log(`🚀 Starting download of ${total} resources with concurrency ${concurrency}`);

  resources.forEach(function(r) {
    if (r.content) {
      operations.push(async function() {
        await writeFile(r.file, r.content);
        completed++;
        if (completed % progressInterval === 0 || completed === total) {
          console.log(`📊 Progress: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
        }
      });
    } else if (r.uri && r.key && decrypt) {
      operations.push(async function() {
        const content = await requestFile(r.uri);
        const decryptedContent = await decryptFile(content, r.key);
        await writeFile(r.file, decryptedContent);
        completed++;
        if (completed % progressInterval === 0 || completed === total) {
          console.log(`📊 Progress: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
        }
      });
    } else if (r.uri && inProgress.indexOf(r.uri) === -1) {
      operations.push(async function() {
        const content = await requestFile(r.uri);
        await writeFile(r.file, content);
        completed++;
        if (completed % progressInterval === 0 || completed === total) {
          console.log(`📊 Progress: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
        }
      });
      inProgress.push(r.uri);
    }
  });

  return Promise.map(operations, function(o) {
    return o();
  }, {concurrency}).then(async function() {
    // Rename root manifest to master.m3u8 after all downloads complete
    if (outputPath) {
      await renameRootManifest(resources, outputPath);
    }
    
    console.log(`🎉 Download completed! Successfully processed ${total} resources.`);
    return Promise.resolve();
  }).catch(function(error) {
    console.error(`💥 Download failed with error:`, error);
    throw error;
  });
};

module.exports = WriteData;
