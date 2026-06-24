import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const brandingDir = join(process.cwd(), 'docs', 'auth0-branding');

test('Auth0 login custom text uses Ditto branding and plain signup footer', () => {
  const login = JSON.parse(readFileSync(join(brandingDir, 'custom-text-login.json'), 'utf8'));
  const loginId = JSON.parse(readFileSync(join(brandingDir, 'custom-text-login-id.json'), 'utf8'));

  assert.match(login.login.title, /Ditto/);
  assert.doesNotMatch(login.login.title, /Jungle Agents/);
  assert.equal(login.login.signupActionText, 'No account yet?');
  assert.equal(login.login.signupActionLinkText, 'Sign up');

  assert.match(loginId['login-id'].title, /Ditto|Welcome back/);
  assert.doesNotMatch(JSON.stringify(loginId), /Jungle Agents/);
  assert.equal(loginId['login-id'].signupActionText, 'No account yet?');
  assert.equal(loginId['login-id'].signupActionLinkText, 'Sign up');
});

test('Auth0 signup custom text uses Ditto branding', () => {
  const signup = JSON.parse(readFileSync(join(brandingDir, 'custom-text-signup.json'), 'utf8'));
  const signupId = JSON.parse(readFileSync(join(brandingDir, 'custom-text-signup-id.json'), 'utf8'));

  assert.match(signup.signup.title, /Ditto/);
  assert.doesNotMatch(signup.signup.title, /Jungle Agents/);
  assert.match(signupId['signup-id'].title, /account/);
  assert.doesNotMatch(JSON.stringify(signupId), /Jungle Agents/);
});

test('apply.sh pushes login-id and signup-id custom text', () => {
  const apply = readFileSync(join(brandingDir, 'apply.sh'), 'utf8');
  assert.match(apply, /prompts\/login-id\/custom-text\/en/);
  assert.match(apply, /prompts\/signup-id\/custom-text\/en/);
  assert.match(apply, /friendly_name\\":\\"Ditto/);
});
