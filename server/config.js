'use strict';

// Optional integrations, all configured through environment variables.

function cloudinaryFromEnv(env) {
  // Either CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud> or the three separate variables.
  if (env.CLOUDINARY_URL) {
    const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(env.CLOUDINARY_URL.trim());
    if (m) return { api_key: m[1], api_secret: m[2], cloud_name: m[3] };
  }
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    return { cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET };
  }
  return null;
}

function loadConfig(env = process.env) {
  return {
    cloudinary: cloudinaryFromEnv(env),
    // Used to turn local numbers such as 01012345678 into international 201012345678.
    defaultCountryCode: (env.DEFAULT_COUNTRY_CODE || '20').replace(/\D/g, ''),
    appName: 'ابتكار',
  };
}

module.exports = { loadConfig };
