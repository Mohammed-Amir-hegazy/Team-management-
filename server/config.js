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
    // Self-service company signup with a free trial (ALLOW_SIGNUP=0 turns it off).
    allowSignup: env.ALLOW_SIGNUP !== '0',
    trialDays: Number(env.TRIAL_DAYS) || 30,
    trialSeats: Number(env.TRIAL_SEATS) || 10,
    // Where companies are directed to renew (the platform owner's WhatsApp / email).
    platformContact: { phone: (env.PLATFORM_CONTACT_PHONE || '').replace(/\D/g, ''), email: env.PLATFORM_CONTACT_EMAIL || '' },
    // The one account that owns the platform, and where its login codes go (WhatsApp/SMS and email).
    platformOwnerEmail: (env.PLATFORM_OWNER_EMAIL || 'mohammedamirwork@gmail.com').trim().toLowerCase(),
    platformOwnerPhone: (env.PLATFORM_OWNER_PHONE || '201018736900').replace(/\D/g, ''),
    // On Render without Turso the database is a file on a disk that is wiped by every deploy.
    ephemeralStorage: !env.TURSO_DATABASE_URL && !!env.RENDER,
  };
}

module.exports = { loadConfig };
