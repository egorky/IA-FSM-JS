// src/authProfileLoader.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const AUTH_PROFILES_DIR = path.join(__dirname, '..', 'config', 'auth_profiles');
let loadedAuthProfiles = null;

function loadAllAuthProfiles() {
  if (loadedAuthProfiles) {
    return loadedAuthProfiles;
  }

  if (!fs.existsSync(AUTH_PROFILES_DIR)) {
    logger.warn(`Auth profiles directory not found: ${AUTH_PROFILES_DIR}. No auth profiles will be loaded.`);
    loadedAuthProfiles = {};
    return loadedAuthProfiles;
  }

  const profiles = {};
  try {
    const files = fs.readdirSync(AUTH_PROFILES_DIR);
    files.forEach(file => {
      if (path.extname(file) === '.json') {
        const filePath = path.join(AUTH_PROFILES_DIR, file);
        try {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const profile = JSON.parse(fileContent);
          if (profile.authProfileId) {
            if (profiles[profile.authProfileId]) {
              logger.warn(`Duplicate authProfileId found: ${profile.authProfileId} in file ${file}. Previous one will be overwritten.`);
            }
            profiles[profile.authProfileId] = profile;
            logger.debug(`Loaded auth profile: ${profile.authProfileId}`);
          } else {
            logger.warn(`Auth profile in file ${file} is missing 'authProfileId'. Skipping.`);
          }
        } catch (err) {
          logger.error({ err, file: filePath }, `Error reading or parsing auth profile file.`);
        }
      }
    });
    loadedAuthProfiles = profiles;
    logger.info(`Successfully loaded ${Object.keys(loadedAuthProfiles).length} auth profiles.`);
  } catch (err) {
    logger.error({ err, dir: AUTH_PROFILES_DIR }, 'Error reading auth profiles directory.');
    loadedAuthProfiles = {}; // Fallback to empty if directory read fails
  }
  return loadedAuthProfiles;
}

function getAuthProfileById(authProfileId) {
  if (!loadedAuthProfiles) {
    loadAllAuthProfiles();
  }
  if (!loadedAuthProfiles[authProfileId]) {
    logger.warn(`Auth profile with ID '${authProfileId}' not found.`);
    return null;
  }
  return loadedAuthProfiles[authProfileId];
}

// Load profiles on server start
loadAllAuthProfiles();

module.exports = {
  loadAllAuthProfiles, // For explicit reload if ever needed
  getAuthProfileById,
};
