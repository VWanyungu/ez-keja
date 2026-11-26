import { testEnv } from './test-env.js';

// `bun run test [files...]`: the unit suite with the mail keys blanked (see scripts/test-env.ts), so a
// developer's real Gmail or Usesendy credentials in .env can never make a test send mail.
const proc = Bun.spawn(['bun', 'test', ...process.argv.slice(2)], {
  env: testEnv(process.env),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exit(await proc.exited);
