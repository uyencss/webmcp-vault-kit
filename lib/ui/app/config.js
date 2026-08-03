export const ringCircumference = 2 * Math.PI * 28;
export const mask = String.fromCharCode(8226).repeat(12);
export const maxCsvBytes = 1024 * 1024;
export const secretFields = ['password', 'otpSecret', 'note'];

// Phase 3: typed items (non-login). `type` is immutable after creation; the
// templates below only seed the create form with default field names + their
// `secret` flag — they are not stored constraints (see plan Data Model).
export const itemTypes = [
  { value: 'login', label: 'Login' },
  { value: 'api_token', label: 'API token' },
  { value: 'ssh_key', label: 'SSH key' },
  { value: 'env', label: 'Env bundle' },
];
export const typeLabels = Object.fromEntries(itemTypes.map((entry) => [entry.value, entry.label]));

export const typeTemplates = {
  api_token: [
    { name: 'token', secret: true },
    { name: 'key_id', secret: false },
    { name: 'header_name', secret: false },
    { name: 'scopes', secret: false },
    { name: 'expires_at', secret: false },
    { name: 'service', secret: false },
  ],
  ssh_key: [
    { name: 'private_key', secret: true },
    { name: 'passphrase', secret: true },
    { name: 'public_key', secret: false },
    { name: 'key_type', secret: false },
    { name: 'comment', secret: false },
    { name: 'host', secret: false },
    { name: 'user', secret: false },
  ],
  // Open map: every entry defaults secret:true; the user may flip individual
  // rows to non-secret (e.g. an optional projectId).
  env: [
    { name: '', secret: true },
  ],
};
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
