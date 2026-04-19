module.exports = {
  apps: [
    {
      name: 'snap-main',
      script: 'node',
      args: 'server.js',
      cron_restart: '*/45 * * * *',
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: 80
      }
    },
    {
      name: 'snap-yt-engine',
      script: 'uvicorn',
      args: 'youtube_server:app --port 5002 --host 127.0.0.1',
      interpreter: 'none',
      cron_restart: '*/45 * * * *',
      max_memory_restart: '1G'
    },
    {
      name: 'snap-tk-engine',
      script: 'gunicorn',
      args: '--bind 127.0.0.1:5000 tiktok_server:app',
      interpreter: 'none',
      cron_restart: '*/45 * * * *',
      max_memory_restart: '500M'
    },
    {
      name: 'snap-social-engine',
      script: 'gunicorn',
      args: '--bind 127.0.0.1:5001 social_server:app',
      interpreter: 'none',
      cron_restart: '*/45 * * * *',
      max_memory_restart: '500M'
    }
  ]
};
