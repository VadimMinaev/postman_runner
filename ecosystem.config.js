module.exports = {
  apps: [
    {
      name: 'postman-runner',
      cwd: __dirname,
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        BASIC_AUTH_USER: 'vadmin',
        BASIC_AUTH_PASS: 'vadmin'
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      max_memory_restart: '300M',
      autorestart: true
    }
  ]
};
