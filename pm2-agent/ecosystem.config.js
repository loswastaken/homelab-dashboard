module.exports = {
  apps: [{
    name:          'pm2-agent',
    script:        './index.js',
    cwd:           __dirname,
    watch:         false,
    restart_delay: 10000,
    max_restarts:  10,
    env: {
      NODE_ENV:          'production',
      DASHBOARD_URL:     'http://10.24.4.26:55964',
      POLL_INTERVAL_MS:  '30000',
      REPORT_API_KEY:    'PASTE_KEY_FROM_DASHBOARD_SETTINGS',
    },
  }],
};
