// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {api} from '../src/release-please';
const myProbotApp = api.handler;
import {RELEASE_PLEASE_LABELS} from '../src/labels';
import {Runner} from '../src/runner';
import {describe, it, beforeEach} from 'mocha';
import {resolve} from 'path';
import {Octokit} from '@octokit/rest';
type OctokitType = InstanceType<typeof Octokit>;
// eslint-disable-next-line node/no-extraneous-import
import {Probot, createProbot, ProbotOctokit} from 'probot';
import {
  PullRequestLabeledEvent,
  PullRequestClosedEvent,
  PullRequestReopenedEvent,
} from '@octokit/webhooks-types';
import * as fs from 'fs';
import yaml from 'js-yaml';
import * as sinon from 'sinon';
import assert, {fail} from 'assert';
import {GitHubRelease, ReleasePR, factory, Errors} from 'release-please';
import * as botConfigModule from '@google-automations/bot-config-utils';
import * as labelUtilsModule from '@google-automations/label-utils';
import nock from 'nock';
// eslint-disable-next-line node/no-extraneous-import
import {RequestError} from '@octokit/request-error';

const sandbox = sinon.createSandbox();
nock.disableNetConnect();
const fixturesPath = resolve(__dirname, '../../test/fixtures');

// helper to get the name of the releaser
function getReleaserName(pr: ReleasePR): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return pr.constructor.name;
}

function assertReleaserType(expectedType: string, pr: ReleasePR) {
  const releaserName = getReleaserName(pr);
  assert(
    expectedType === releaserName,
    `expected to find ${expectedType}, found ${releaserName}`
  );
}

function loadConfig(configFile: string) {
  return yaml.load(
    fs.readFileSync(resolve(fixturesPath, 'config', configFile), 'utf-8')
  );
}

function stubDefaultBranchLookup() {
  sandbox.replace(
    api,
    'getRepositoryDefaultBranch',
    async (
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      owner: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      repo: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _octokit: OctokitType
    ): Promise<string> => {
      return 'master';
    }
  );
}

describe('ReleasePleaseBot', () => {
  let probot: Probot;
  let getConfigStub: sinon.SinonStub;

  beforeEach(() => {
    probot = createProbot({
      overrides: {
        githubToken: 'abc123',
        Octokit: ProbotOctokit.defaults({
          retry: {enabled: false},
          throttle: {enabled: false},
        }),
      },
    });
    probot.load(myProbotApp);
    getConfigStub = sandbox.stub(botConfigModule, 'getConfig');
  });

  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  describe('push to master branch', () => {
    let payload: {};

    beforeEach(() => {
      payload = require(resolve(fixturesPath, './push_to_master'));
    });

    it('should build a release PR', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('valid.yml'));

      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should handle GitHub releases, if configured', async () => {
      let runnerExecuted = false;
      let releaserExecuted = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        runnerExecuted = true;
      });
      sandbox.replace(Runner, 'releaser', async (pr: GitHubRelease) => {
        assert(pr instanceof GitHubRelease);
        releaserExecuted = true;
      });
      const releaseSpy = sandbox.spy(factory, 'githubRelease');
      getConfigStub.resolves(loadConfig('valid_handle_gh_release.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(runnerExecuted, 'should have executed the runner');
      assert(releaserExecuted, 'GitHub release should have run');
      assert(releaseSpy.calledWith(sinon.match.has('releaseLabel', undefined)));
    });

    it('should ignore duplicated GitHub releases', async () => {
      let runnerExecuted = false;
      let releaserExecuted = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        runnerExecuted = true;
      });
      sandbox.replace(Runner, 'releaser', async (pr: GitHubRelease) => {
        assert(pr instanceof GitHubRelease);
        releaserExecuted = true;

        throw new Errors.DuplicateReleaseError(
          new RequestError('foo', 400, {
            response: {
              data: 'something',
              status: 400,
              url: 'https://foo.bar',
              headers: {},
            },
            request: {
              method: 'POST',
              url: 'https://foo.bar',
              headers: {},
            },
          }),
          'abc'
        );
      });
      const releaseSpy = sandbox.spy(factory, 'githubRelease');
      getConfigStub.resolves(loadConfig('valid_handle_gh_release.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(runnerExecuted, 'should have executed the runner');
      assert(releaserExecuted, 'GitHub release should have run');
      assert(releaseSpy.calledWith(sinon.match.has('releaseLabel', undefined)));
    });

    it('should ignore configuration errors', async () => {
      let runnerExecuted = false;
      const releaserExecuted = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        runnerExecuted = true;

        throw new Errors.MissingRequiredFileError(
          'versions.txt',
          'YoshiJava',
          'testOwner/testRepo'
        );
      });
      sandbox.replace(Runner, 'releaser', async () => {
        fail('should not get here');
      });
      getConfigStub.resolves(loadConfig('valid_handle_gh_release.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(runnerExecuted, 'should have executed the runner');
      assert(!releaserExecuted, 'GitHub release should not have run');
    });

    it('should ignore if the branch is the configured primary branch', async () => {
      sandbox.stub(Runner, 'runner').rejects('should not be running a release');
      getConfigStub.resolves(loadConfig('feature_branch_as_primary.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
    });

    it('should allow overriding the release strategy from configuration', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('Ruby', pr);
        executed = true;
      });
      stubDefaultBranchLookup();
      getConfigStub.resolves(loadConfig('ruby_release.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should allow overriding the package-name from configuration', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assert.deepStrictEqual(pr.packageName, '@google-cloud/foo');
        executed = true;
      });
      stubDefaultBranchLookup();
      getConfigStub.resolves(loadConfig('ruby_release_alternate_pkg_name.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should allow overriding the release tags from configuration', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assert.deepStrictEqual(pr.labels, ['foo', 'bar']);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('valid.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should allow overriding the release label when creating a release', async () => {
      let runnerExecuted = false;
      let releaserExecuted = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        runnerExecuted = true;
      });
      sandbox.replace(Runner, 'releaser', async (pr: GitHubRelease) => {
        assert(pr instanceof GitHubRelease);
        assert.strictEqual(pr.releaseLabel, 'autorelease: published');
        releaserExecuted = true;
      });
      const releaseSpy = sandbox.spy(factory, 'githubRelease');
      getConfigStub.resolves(loadConfig('override_release_tag.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(runnerExecuted, 'should have executed the runner');
      assert(releaserExecuted, 'GitHub release should have run');
      assert(
        releaseSpy.calledWith(
          sinon.match.has('releaseLabel', 'autorelease: published')
        )
      );
    });

    it('should ignore webhook if not configured', async () => {
      sandbox.stub(Runner, 'runner').rejects('should not be running a release');
      getConfigStub.resolves(null);
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
    });

    it('should allow an empty config file with the defaults', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      stubDefaultBranchLookup();
      getConfigStub.resolves({});
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should allow configuring minor bump for breaking change pre 1.0', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        assert(pr.bumpMinorPreMajor);
        executed = true;
      });
      stubDefaultBranchLookup();
      getConfigStub.resolves(loadConfig('minor_pre_major.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should detect the default branch if not specified in configuration', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('Node', pr);
        assert('master' === pr.gh.defaultBranch);
        executed = true;
      });
      stubDefaultBranchLookup();
      getConfigStub.resolves(loadConfig('release_type_no_primary_branch.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    describe('for manifest releases', () => {
      it('should build a release PR', async () => {
        const manifest = sandbox.stub(Runner, 'manifest').resolves();
        getConfigStub.resolves(loadConfig('manifest.yml'));
        stubDefaultBranchLookup();
        await probot.receive(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {name: 'push', payload: payload as any, id: 'abc123'}
        );
        assert(manifest.called, 'should have executed the runner');
      });

      it('should handle GitHub releases, if configured', async () => {
        const manifest = sandbox.stub(Runner, 'manifest').resolves();
        const manifestRelease = sandbox
          .stub(Runner, 'manifestRelease')
          .resolves();
        getConfigStub.resolves(loadConfig('manifest_handle_gh_release.yml'));
        await probot.receive(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {name: 'push', payload: payload as any, id: 'abc123'}
        );
        assert(manifest.called, 'should have executed the runner');
        assert(manifestRelease.called, 'GitHub release should have run');
      });

      it('should ignore the repo language not being supported', async () => {
        payload = require(resolve(
          fixturesPath,
          './push_to_master_weird_language'
        ));
        const manifest = sandbox.stub(Runner, 'manifest').resolves();
        getConfigStub.resolves(loadConfig('manifest.yml'));
        stubDefaultBranchLookup();
        await probot.receive(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {name: 'push', payload: payload as any, id: 'abc123'}
        );
        assert(manifest.called, 'should have executed the runner');
      });
    });

    it('should allow configuring extra files', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assert.deepStrictEqual(pr.extraFiles, [
          'src/com/google/foo/Version.java',
        ]);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('extra_files.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });
  });

  describe('push to non-master branch', () => {
    let payload: {};

    beforeEach(() => {
      payload = require(resolve(fixturesPath, './push_to_non_master'));
    });

    it('should ignore the webhook', async () => {
      sandbox.stub(Runner, 'runner').rejects('should not be running a release');
      getConfigStub.resolves(loadConfig('valid.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
    });

    it('should create the PR if the branch is the configured primary branch', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('feature_branch_as_primary.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should create the PR if the branch is configured as an alternate branch', async () => {
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('multi_branch.yml'));
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(executed, 'should have executed the runner');
    });

    it('should handle GitHub releases, if configured', async () => {
      let runnerExecuted = false;
      let releaserExecuted = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        runnerExecuted = true;
      });
      sandbox.replace(Runner, 'releaser', async (pr: GitHubRelease) => {
        assert(pr instanceof GitHubRelease);
        assert(pr.gh.defaultBranch === 'feature-branch');
        releaserExecuted = true;
      });
      const releaseSpy = sandbox.spy(factory, 'githubRelease');
      getConfigStub.resolves(
        loadConfig('valid_handle_gh_release_alternate_branch.yml')
      );
      await probot.receive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {name: 'push', payload: payload as any, id: 'abc123'}
      );
      assert(runnerExecuted, 'should have executed the runner');
      assert(releaserExecuted, 'GitHub release should have run');
      assert(releaseSpy.calledWith(sinon.match.has('releaseLabel', undefined)));
    });
  });

  describe('nightly event', () => {
    it('should try to create a snapshot', async () => {
      let executed = false;
      const syncLabelsStub = sandbox.stub(labelUtilsModule, 'syncLabels');
      const payload = {
        repository: {
          name: 'Hello-World',
          full_name: 'Codertocat/Hello-World',
          owner: {
            login: 'Codertocat',
          },
        },
        organization: {
          login: 'Codertocat',
        },
        cron_org: 'Codertocat',
      };
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('valid.yml'));
      const repository = require(resolve(fixturesPath, './repository'));
      const requests = nock('https://api.github.com')
        .get('/repos/Codertocat/Hello-World')
        .reply(200, repository);

      await probot.receive({
        // See: https://github.com/octokit/webhooks.js/issues/277
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        name: 'schedule.repository' as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: payload as any,
        id: 'abc123',
      });
      requests.done();
      assert(executed, 'should have executed the runner');
      sinon.assert.calledOnceWithExactly(
        syncLabelsStub,
        sinon.match.instanceOf(ProbotOctokit),
        'Codertocat',
        'Hello-World',
        sinon.match.array.deepEquals(RELEASE_PLEASE_LABELS)
      );
    });

    it('should try to create a snapshot even when syncLabels fails', async () => {
      let executed = false;
      const syncLabelsStub = sandbox.stub(labelUtilsModule, 'syncLabels');
      syncLabelsStub.rejects(new Error('Testing failure case'));
      const payload = {
        repository: {
          name: 'Hello-World',
          full_name: 'Codertocat/Hello-World',
          owner: {
            login: 'Codertocat',
          },
        },
        organization: {
          login: 'Codertocat',
        },
        cron_org: 'Codertocat',
      };
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('valid.yml'));
      const repository = require(resolve(fixturesPath, './repository'));
      const requests = nock('https://api.github.com')
        .get('/repos/Codertocat/Hello-World')
        .reply(200, repository);

      await probot.receive({
        // See: https://github.com/octokit/webhooks.js/issues/277
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        name: 'schedule.repository' as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: payload as any,
        id: 'abc123',
      });
      requests.done();
      assert(executed, 'should have executed the runner');
      sinon.assert.calledOnceWithExactly(
        syncLabelsStub,
        sinon.match.instanceOf(ProbotOctokit),
        'Codertocat',
        'Hello-World',
        sinon.match.array.deepEquals(RELEASE_PLEASE_LABELS)
      );
    });

    it('should try to create a snapshot on multiple branches', async () => {
      const syncLabelsStub = sandbox.stub(labelUtilsModule, 'syncLabels');
      const executedBranches: Map<string, string> = new Map();
      const payload = {
        repository: {
          name: 'Hello-World',
          full_name: 'Codertocat/Hello-World',
          owner: {
            login: 'Codertocat',
          },
        },
        organization: {
          login: 'Codertocat',
        },
        cron_org: 'Codertocat',
      };
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        executedBranches.set(pr.gh.defaultBranch!, getReleaserName(pr));
      });
      getConfigStub.resolves(loadConfig('multi_branch.yml'));
      const repository = require(resolve(fixturesPath, './repository'));
      const requests = nock('https://api.github.com')
        .get('/repos/Codertocat/Hello-World')
        .reply(200, repository);

      await probot.receive({
        // See: https://github.com/octokit/webhooks.js/issues/277
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        name: 'schedule.repository' as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: payload as any,
        id: 'abc123',
      });
      requests.done();
      assert(executedBranches.get('master') === 'JavaBom');
      assert(executedBranches.get('feature-branch') === 'JavaYoshi');
      sinon.assert.calledOnceWithExactly(
        syncLabelsStub,
        sinon.match.instanceOf(ProbotOctokit),
        'Codertocat',
        'Hello-World',
        sinon.match.array.deepEquals(RELEASE_PLEASE_LABELS)
      );
    });
  });

  describe('pull-request labeled event', () => {
    let payload: {};

    it('should try to create a release', async () => {
      payload = require(resolve(fixturesPath, './pull_request_labeled'));
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('valid.yml'));
      const requests = nock('https://api.github.com')
        .delete(
          '/repos/Codertocat/Hello-World/issues/2/labels/release-please%3Aforce-run'
        )
        .reply(200);

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestLabeledEvent,
        id: 'abc123',
      });
      requests.done();
      assert(executed, 'should have executed the runner');
    });

    it('should try to create a release on an alternate branch', async () => {
      payload = require(resolve(
        fixturesPath,
        './pull_request_labeled_feature_branch'
      ));
      let executed = false;
      sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
        assertReleaserType('JavaYoshi', pr);
        executed = true;
      });
      getConfigStub.resolves(loadConfig('multi_branch.yml'));
      const requests = nock('https://api.github.com')
        .delete(
          '/repos/Codertocat/Hello-World/issues/2/labels/release-please%3Aforce-run'
        )
        .reply(200);

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestLabeledEvent,
        id: 'abc123',
      });
      requests.done();
      assert(executed, 'should have executed the runner');
    });

    it('should ignore other labels', async () => {
      payload = require(resolve(fixturesPath, './pull_request_labeled_other'));
      sandbox.stub(Runner, 'runner').rejects('should not be running a release');

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestLabeledEvent,
        id: 'abc123',
      });
    });
  });

  describe('pull request closed', () => {
    let payload: {};

    it('should try to mark closed', async () => {
      payload = require(resolve(fixturesPath, './pr_closed'));
      getConfigStub.resolves(loadConfig('valid.yml'));
      const requests = nock('https://api.github.com')
        .delete(
          '/repos/testOwner/testRepo/issues/12/labels/autorelease%3A%20pending'
        )
        .reply(200)
        .post('/repos/testOwner/testRepo/issues/12/labels')
        .reply(200);

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestClosedEvent,
        id: 'abc123',
      });

      requests.done();
    });

    it('should ignore non-release pull requests', async () => {
      payload = require(resolve(fixturesPath, './pr_closed_non_release'));
      getConfigStub.resolves(loadConfig('valid.yml'));

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestClosedEvent,
        id: 'abc123',
      });
    });

    it('should ignore merged pull requests', async () => {
      payload = require(resolve(fixturesPath, './pr_merged'));
      getConfigStub.resolves(loadConfig('valid.yml'));

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestClosedEvent,
        id: 'abc123',
      });
    });
  });

  describe('pull request reopened', () => {
    let payload: {};

    it('should try to mark pending', async () => {
      payload = require(resolve(fixturesPath, './pr_reopened'));
      getConfigStub.resolves(loadConfig('valid.yml'));
      const requests = nock('https://api.github.com')
        .delete(
          '/repos/testOwner/testRepo/issues/12/labels/autorelease%3A%20closed'
        )
        .reply(200)
        .post('/repos/testOwner/testRepo/issues/12/labels')
        .reply(200);

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestReopenedEvent,
        id: 'abc123',
      });

      requests.done();
    });

    it('should ignore non-release pull requests', async () => {
      payload = require(resolve(fixturesPath, './pr_reopened_non_release'));
      getConfigStub.resolves(loadConfig('valid.yml'));

      await probot.receive({
        name: 'pull_request',
        payload: payload as PullRequestReopenedEvent,
        id: 'abc123',
      });
    });
  });

  it('should fetch default branch from GitHub if not provided', async () => {
    const payload = require(resolve(fixturesPath, './push_to_main'));
    let executed = false;
    sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
      assertReleaserType('Ruby', pr);
      executed = true;
    });
    const requests = nock('https://api.github.com')
      .get('/repos/chingor13/google-auth-library-java')
      .reply(200, {
        default_branch: 'main',
      });
    getConfigStub.resolves(loadConfig('ruby_release.yml'));
    await probot.receive(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {name: 'push', payload: payload as any, id: 'abc123'}
    );
    assert(executed, 'should have executed the runner');
    requests.done();
  });

  it('should use primaryBranch from config if one is set', async () => {
    const payload = require(resolve(fixturesPath, './push_to_main'));
    let executed = false;
    sandbox.replace(Runner, 'runner', async (pr: ReleasePR) => {
      assertReleaserType('JavaYoshi', pr);
      executed = true;
    });
    getConfigStub.resolves(loadConfig('main_branch.yml'));
    await probot.receive(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {name: 'push', payload: payload as any, id: 'abc123'}
    );
    assert(executed, 'should have executed the runner');
  });
});
