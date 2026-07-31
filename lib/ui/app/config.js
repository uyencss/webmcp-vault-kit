export const ringCircumference = 2 * Math.PI * 28;
export const mask = String.fromCharCode(8226).repeat(12);
export const maxCsvBytes = 1024 * 1024;
export const secretFields = ['password', 'otpSecret', 'note'];
export const secretConfig = {
  password: {
    inputId: 'password',
    toggleId: 'passwordRevealButton',
    apiField: 'password',
    savedFlag: 'hasPassword',
    label: 'Password',
    placeholder: 'Password',
  },
  otpSecret: {
    inputId: 'otpSecret',
    toggleId: 'otpSecretRevealButton',
    apiField: 'otp-secret',
    savedFlag: 'hasOtp',
    label: 'TOTP secret',
    placeholder: 'TOTP secret',
  },
  note: {
    inputId: 'note',
    toggleId: 'noteRevealButton',
    apiField: 'note',
    savedFlag: 'hasNote',
    label: 'Note',
    placeholder: 'Note',
  },
};
export const demoItems = [
  {
    title: 'GitHub',
    web: 'https://github.com/login',
    username: 'octo@example.test',
    password: 'demo-github-password',
    otpSecret: 'JBSWY3DPEHPK3PXP',
    note: 'Synthetic demo login. Replace with a real entry only in your own vault.',
  },
  {
    title: 'Cloudflare',
    web: 'https://dash.cloudflare.com',
    username: 'ops@example.test',
    password: 'demo-cloudflare-password',
    otpSecret: 'otpauth://totp/WebMCP:ops?secret=JBSWY3DPEHPK3PXP&issuer=WebMCP&digits=6&period=30',
    note: 'Synthetic demo entry for checking the TOTP ring and redaction controls.',
  },
  {
    title: 'Fastmail',
    web: 'https://app.fastmail.com',
    username: 'me@example.test',
    password: 'demo-fastmail-password',
    otpSecret: '',
    note: 'Synthetic demo entry with no TOTP secret.',
  },
  {
    title: 'WebMCP Telegram Control Bot',
    web: 'https://t.me',
    username: '@webmcp_hieunq_control_bot',
    password: 'demo-telegram-bot-token',
    otpSecret: '',
    note: 'Synthetic demo entry.',
  },
  {
    title: 'WebMCP Telegram Execution Controller',
    web: 'http://127.0.0.1',
    username: 'telegram-control',
    password: 'demo-telegram-control-password',
    otpSecret: '',
    note: 'Synthetic demo entry.',
  },
  {
    title: 'WebMCP Node Executor',
    web: 'http://127.0.0.1',
    username: 'node-executor',
    password: 'demo-node-executor-password',
    otpSecret: '',
    note: 'Synthetic demo entry.',
  },
];
