module.exports = {
  apps: [
    {
      name: "shield-software-gateway",
      script: "./index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1500M",
      // Allows the gateway to stop its bot processes and close connections on shutdown.
      kill_timeout: 6000,
      env: {
        NODE_ENV: "production",
        GATEWAY_PORT: 3000,
        PM2_DISCORD_SEPARATE: "false"
      }
    }
  ]
};
