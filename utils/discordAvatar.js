const CDN = "https://cdn.discordapp.com";
const FALLBACK_AVATAR = `${CDN}/embed/avatars/0.png`;

function defaultAvatarUrl(userId, discriminator) {
  try {
    const index = discriminator && discriminator !== "0"
      ? parseInt(discriminator, 10) % 5
      : Number((BigInt(userId) >> 22n) % 6n);
    return `${CDN}/embed/avatars/${index}.png`;
  } catch (err) {
    return FALLBACK_AVATAR;
  }
}

// Avatar URL for a raw Discord user object ({ id, avatar, discriminator }).
function userAvatarUrl(user) {
  if (!user || !user.id) return FALLBACK_AVATAR;
  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return `${CDN}/avatars/${user.id}/${user.avatar}.${ext}`;
  }
  return defaultAvatarUrl(user.id, user.discriminator);
}

module.exports = { CDN, FALLBACK_AVATAR, defaultAvatarUrl, userAvatarUrl };
