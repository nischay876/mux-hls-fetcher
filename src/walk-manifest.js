/* eslint-disable no-console */
const m3u8 = require('m3u8-parser');
const mpd = require('mpd-parser');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const url = require('url');
const path = require('path');
const querystring = require('querystring');
const filenamify = require('filenamify');

// Configure axios retry
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ECONNABORTED';
  }
});

// replace invalid http/fs characters with valid representations
const fsSanitize = function (filepath) {
  return path.normalize(filepath)
    // split on \, \\, or /
    .split(/\\\\|\\|\//)
    // max filepath is 255 on OSX/linux, and 260 on windows, 255 is fine for both
    // replace invalid characters with nothing
    .map((p) => filenamify(querystring.unescape(p), { replacement: '', maxLength: 255 }))
    // join on OS specific path separator
    .join(path.sep);
};

const urlBasename = function (uri) {
  const parsed = url.parse(uri);
  const pathname = parsed.pathname || parsed.path.split('?')[0];
  const basename = path.basename(pathname);

  return fsSanitize(basename);
};

const joinURI = function (absolute, relative) {
  const abs = url.parse(absolute);
  const rel = url.parse(relative);

  abs.pathname = path.resolve(abs.pathname, rel.pathname);

  abs.query = rel.query;
  abs.hash = rel.hash;

  return url.format(abs);
};

const isAbsolute = function (uri) {
  const parsed = url.parse(uri);

  if (parsed.protocol) {
    return true;
  }
  return false;
};

const mediaGroupPlaylists = function (mediaGroups) {
  const playlists = [];

  ['AUDIO', 'VIDEO', 'CLOSED-CAPTIONS', 'SUBTITLES'].forEach(function (type) {
    const mediaGroupType = mediaGroups[type];

    if (mediaGroupType && !Object.keys(mediaGroupType).length) {
      return;
    }

    for (const group in mediaGroupType) {
      for (const item in mediaGroupType[group]) {
        const props = mediaGroupType[group][item];

        playlists.push(props);
      }
    }
  });
  return playlists;
};

const parseM3u8Manifest = function (content) {
  const parser = new m3u8.Parser();

  parser.push(content);
  parser.end();
  return parser.manifest;
};

const collectPlaylists = function (parsed) {
  return []
    .concat(parsed.playlists || [])
    .concat(mediaGroupPlaylists(parsed.mediaGroups || {}) || [])
    .reduce(function (acc, p) {
      acc.push(p);

      if (p.playlists) {
        acc = acc.concat(collectPlaylists(p));
      }
      return acc;
    }, []);
};

const parseMpdManifest = function (content, srcUrl) {
  const parsedManifestInfo = mpd.inheritAttributes(mpd.stringToMpdXml(content), {
    manifestUri: srcUrl
  });
  const mpdPlaylists = mpd.toPlaylists(parsedManifestInfo.representationInfo);

  const m3u8Result = mpd.toM3u8(mpdPlaylists);
  const m3u8Playlists = collectPlaylists(m3u8Result);

  m3u8Playlists.forEach(function (m) {
    const mpdPlaylist = m.attributes && mpdPlaylists.find(function (p) {
      return p.attributes.id === m.attributes.NAME;
    });

    if (mpdPlaylist) {
      m.dashattributes = mpdPlaylist.attributes;
    }
    // add sidx to segments
    if (m.sidx) {
      // fix init segment map if it has one
      if (m.sidx.map && !m.sidx.map.uri) {
        m.sidx.map.uri = m.sidx.map.resolvedUri;
      }

      m.segments.push(m.sidx);
    }
  });

  return m3u8Result;
};

const parseKey = function (requestOptions, basedir, decrypt, resources, manifest, parent) {
  return new Promise(function (resolve, reject) {

    if (!manifest.parsed.segments[0] || !manifest.parsed.segments[0].key) {
      return resolve({});
    }
    const key = manifest.parsed.segments[0].key;

    let keyUri = key.uri;

    // Strip query parameters for cleaner local storage
    const parsedKeyUri = url.parse(keyUri);
    if (parsedKeyUri.pathname) {
      const cleanKeyUri = url.format({
        protocol: parsedKeyUri.protocol,
        host: parsedKeyUri.host,
        pathname: parsedKeyUri.pathname
      });
      keyUri = cleanKeyUri;
    }

    // if we are not decrypting then we just download the key
    if (!decrypt) {
      // put keys in parent-dir/key-name.key
      key.file = basedir;
      if (parent) {
        key.file = path.dirname(parent.file);
      }
      key.file = path.join(key.file, urlBasename(keyUri));

      manifest.content = Buffer.from(manifest.content.toString().replace(
        key.uri,
        path.relative(path.dirname(manifest.file), key.file)
      ));

      if (!isAbsolute(keyUri)) {
        keyUri = joinURI(path.dirname(manifest.uri), keyUri);
      }
      key.uri = keyUri;
      resources.push(key);
      return resolve(key);
    }

    // get the aes key using axios
    axios({
      url: keyUri,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: requestOptions.time || 15000
    })
      .then(function (response) {
        if (response.status !== 200) {
          const keyError = new Error(response.status + '|' + keyUri);
          console.error(keyError);
          return reject(keyError);
        }

        const keyContent = Buffer.from(response.data);

        key.bytes = new Uint32Array([
          keyContent.readUInt32BE(0),
          keyContent.readUInt32BE(4),
          keyContent.readUInt32BE(8),
          keyContent.readUInt32BE(12)
        ]);

        // remove the key from the manifest
        manifest.content = Buffer.from(manifest.content.toString().replace(
          new RegExp('.*' + key.uri + '.*'),
          ''
        ));

        resolve(key);
      })
      .catch(function (err) {
        // TODO: do we even care about key errors; currently we just keep going and ignore them.
        const keyError = new Error(err.message + '|' + keyUri);
        console.error(keyError, err);
        reject(keyError);
      });
  });
};

const walkPlaylist = function (options) {
  return new Promise(function (resolve, reject) {

    const {
      decrypt,
      basedir,
      uri,
      parent = false,
      manifestIndex = 0,
      onError = function (err, errUri, resources, res, rej) {
        // Avoid adding the top level uri to nested errors
        if (err.message.includes('|')) {
          rej(err);
        } else {
          rej(new Error(err.message + '|' + errUri));
        }
      },
      visitedUrls = [],
      requestTimeout = 15000,
      requestRetryMaxAttempts = 3,
      dashPlaylist = null,
      requestRetryDelay = 1000
    } = options;

    let resources = [];
    const manifest = { parent };

    if (uri) {
      manifest.uri = uri;
      // For the root manifest (no parent), name it master.m3u8
      if (!parent) {
        manifest.file = path.join(basedir, 'master.m3u8');
      } else {
        manifest.file = path.join(basedir, urlBasename(uri));
      }
    }

    let existingManifest;

    // if we are not the master playlist
    if (dashPlaylist && parent) {
      manifest.file = parent.file;
      manifest.uri = parent.uri;
      existingManifest = visitedUrls[manifest.uri];
    } else if (parent) {
      // For the root manifest, ensure it's named master.m3u8
      if (!parent) {
        manifest.file = path.join(basedir, 'master.m3u8');
      } else {
        manifest.file = path.join(
          basedir,
          path.dirname(path.relative(basedir, parent.file)),
          'manifest' + manifestIndex,
          path.basename(manifest.file)
        );
      }


      const file = existingManifest && existingManifest.file || manifest.file;
      const relativePath = path.relative(path.dirname(parent.file), file);

      // replace original uri in file with new file path
      parent.content = Buffer.from(parent.content.toString().replace(manifest.uri, relativePath));

      // get the real uri of this playlist
      if (!isAbsolute(manifest.uri)) {
        manifest.uri = joinURI(path.dirname(parent.uri), manifest.uri);
      }

      existingManifest = visitedUrls[manifest.uri];
    }

    if (!dashPlaylist && existingManifest) {
      console.error(`[WARN] Trying to visit the same uri again; skipping to avoid getting stuck in a cycle: ${manifest.uri}`);
      return resolve(resources);
    }
    visitedUrls[manifest.uri] = manifest;

    let requestPromise;

    if (dashPlaylist) {
      requestPromise = Promise.resolve({ status: 200 });
    } else {
      requestPromise = axios({
        url: manifest.uri,
        method: 'GET',
        timeout: requestTimeout,
        responseType: 'text'
      });
    }

    requestPromise.then(function (response) {
      if (response.status !== 200) {
        const manifestError = new Error(response.status + '|' + manifest.uri);

        manifestError.response = { data: response.data, headers: response.headers };
        return onError(manifestError, manifest.uri, resources, resolve, reject);
      }
      // Only push manifest uris that get a non 200 and don't timeout
      let dash;

      if (!dashPlaylist) {
        resources.push(manifest);

        manifest.content = response.data;
        if ((/^application\/dash\+xml/i).test(response.headers['content-type']) || (/^\<\?xml/i).test(response.data)) {
          dash = true;
          manifest.parsed = parseMpdManifest(manifest.content, manifest.uri);
        } else {
          manifest.parsed = parseM3u8Manifest(manifest.content);
        }
      } else {
        dash = true;
        manifest.parsed = dashPlaylist;
      }

      manifest.parsed.segments = manifest.parsed.segments || [];
      manifest.parsed.playlists = manifest.parsed.playlists || [];
      manifest.parsed.mediaGroups = manifest.parsed.mediaGroups || {};

      const initSegments = [];

      manifest.parsed.segments.forEach(function (s) {
        if (s.map && s.map.uri && !initSegments.some((m) => s.map.uri === m.uri)) {
          manifest.parsed.segments.push(s.map);
          initSegments.push(s.map);
        }
      });

      const playlists = manifest.parsed.playlists.concat(mediaGroupPlaylists(manifest.parsed.mediaGroups));

      parseKey({
        time: requestTimeout,
        maxAttempts: requestRetryMaxAttempts,
        retryDelay: requestRetryDelay
      }, basedir, decrypt, resources, manifest, parent).then(function (key) {
        // SEGMENTS
        manifest.parsed.segments.forEach(function (s, i) {
          if (!s.uri) {
            return;
          }

          // Strip query parameters for clean local filename
          const parsedSegmentUri = url.parse(s.uri);
          let cleanSegmentUri = s.uri;
          if (parsedSegmentUri.pathname) {
            cleanSegmentUri = url.format({
              protocol: parsedSegmentUri.protocol,
              host: parsedSegmentUri.host,
              pathname: parsedSegmentUri.pathname
            });
          }

          // put segments in manifest-name/segment-name.ts
          s.file = path.join(path.dirname(manifest.file), urlBasename(cleanSegmentUri));

          if (manifest.content) {
            manifest.content = Buffer.from(manifest.content.toString().replace(
              s.uri,
              path.relative(path.dirname(manifest.file), s.file)
            ));
          }

          if (!isAbsolute(s.uri)) {
            s.uri = joinURI(path.dirname(manifest.uri), s.uri);
          }
          if (key) {
            s.key = key;
            s.key.iv = s.key.iv || new Uint32Array([0, 0, 0, manifest.parsed.mediaSequence, i]);
          }
          resources.push(s);
        });

        // SUB Playlists
        const subs = playlists.map(function (p, z) {
          if (!p.uri && !dash) {
            return Promise.resolve(resources);
          }

          // Strip query parameters for clean playlist URI
          let cleanPlaylistUri = p.uri;
          if (p.uri) {
            const parsedPlaylistUri = url.parse(p.uri);
            if (parsedPlaylistUri.pathname) {
              cleanPlaylistUri = url.format({
                protocol: parsedPlaylistUri.protocol,
                host: parsedPlaylistUri.host,
                pathname: parsedPlaylistUri.pathname
              });
            }
          }

          return walkPlaylist({
            dashPlaylist: dash ? p : null,
            decrypt,
            basedir,
            uri: p.uri,
            parent: manifest,
            manifestIndex: z,
            onError,
            visitedUrls,
            requestTimeout,
            requestRetryMaxAttempts,
            requestRetryDelay
          });
        });

        Promise.all(subs).then(function (r) {
          const flatten = [].concat.apply([], r);

          resources = resources.concat(flatten);
          resolve(resources);
        }).catch(function (err) {
          onError(err, manifest.uri, resources, resolve, reject);
        });
      });
    })
      .catch(function (err) {
        onError(err, manifest.uri, resources, resolve, reject);
      });
  });
};

module.exports = walkPlaylist;
