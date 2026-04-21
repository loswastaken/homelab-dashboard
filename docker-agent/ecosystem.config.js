module.exports = {
  apps: [{
    name:          'docker-agent',
    script:        './index.js',
    cwd:           __dirname,
    watch:         false,
    restart_delay: 10000,
    max_restarts:  10,
    env: {
      NODE_ENV:         'production',
      DASHBOARD_URL:    'http://YOUR_DASHBOARD_HOST:55964',
      POLL_INTERVAL_MS: '30000',
      REPORT_API_KEY:   'PASTE_KEY_FROM_DASHBOARD_SETTINGS',
      // AGENT_NAME:    'my-host', // optional — defaults to os.hostname()
    },
  }],
};
