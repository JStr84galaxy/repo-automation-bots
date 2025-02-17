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

// eslint-disable-next-line node/no-extraneous-import
import {Probot} from 'probot';
import {
  ReleasePRFactoryOptions,
  GitHubReleaseFactoryOptions,
  ReleasePR,
  factory,
  setLogger,
  Errors,
} from 'release-please';
import {Runner} from './runner';
// eslint-disable-next-line node/no-extraneous-import
import {Octokit} from '@octokit/rest';
// We pull in @octokit/request to crreate an appropriate type for the
// GitHubAPI interface:
// eslint-disable-next-line node/no-extraneous-import
import {request} from '@octokit/request';
import {logger} from 'gcf-utils';
import {
  ReleaseType,
  getReleaserNames,
} from 'release-please/build/src/releasers';
import {ConfigChecker, getConfig} from '@google-automations/bot-config-utils';
import {syncLabels} from '@google-automations/label-utils';
import {Manifest} from 'release-please/build/src/manifest';
import schema from './config-schema.json';
import {
  BranchConfiguration,
  ConfigurationOptions,
  WELL_KNOWN_CONFIGURATION_FILE,
  DEFAULT_CONFIGURATION,
} from './config-constants';
import {FORCE_RUN_LABEL, RELEASE_PLEASE_LABELS} from './labels';
type RequestBuilderType = typeof request;
type DefaultFunctionType = RequestBuilderType['defaults'];
type RequestFunctionType = ReturnType<DefaultFunctionType>;

type OctokitType = InstanceType<typeof Octokit>;

interface GitHubAPI {
  graphql: Function;
  request: RequestFunctionType;
}

const DEFAULT_API_URL = 'https://api.github.com';

function releaseTypeFromRepoLanguage(language: string | null): ReleaseType {
  if (language === null) {
    throw Error('repository has no detected language');
  }
  switch (language.toLowerCase()) {
    case 'java':
      return 'java-yoshi';
    case 'typescript':
    case 'javascript':
      return 'node';
    case 'php':
      return 'php-yoshi';
    case 'go':
      return 'go-yoshi';
    default: {
      const releasers = getReleaserNames();
      if (releasers.includes(language.toLowerCase())) {
        return language.toLowerCase() as ReleaseType;
      } else {
        throw Error(`unknown release type: ${language}`);
      }
    }
  }
}

function findBranchConfiguration(
  branch: string,
  config: ConfigurationOptions
): BranchConfiguration | null {
  // look at primaryBranch first
  if (branch === config.primaryBranch) {
    return {
      ...config,
      ...{branch},
    };
  }

  if (!config.branches) {
    return null;
  }

  try {
    const found = config.branches.find(branchConfig => {
      return branch === branchConfig.branch;
    });
    if (found) {
      return found;
    }
  } catch (e) {
    const err = e as Error;
    err.message =
      `got an error finding the branch config: ${err.message},` +
      `config: ${JSON.stringify(config)}`;
    logger.error(err);
  }
  return null;
}

// turn a merged release-please release PR into a GitHub release.
async function createGitHubRelease(
  packageName: string,
  repoUrl: string,
  configuration: BranchConfiguration,
  github: GitHubAPI
) {
  const releaseOptions: GitHubReleaseFactoryOptions = {
    label: 'autorelease: pending',
    repoUrl,
    packageName,
    apiUrl: DEFAULT_API_URL,
    octokitAPIs: {
      octokit: github as {} as OctokitType,
      graphql: github.graphql,
      request: github.request,
    },
    path: configuration.path,
    changelogPath: configuration.changelogPath ?? 'CHANGELOG.md',
    monorepoTags: configuration.monorepoTags,
    releaseType: configuration.releaseType,
    extraFiles: configuration.extraFiles,
    releaseLabel: configuration.releaseLabel,
    defaultBranch: configuration.branch,
  };
  if (configuration.manifest) {
    const manifest = factory.manifest(releaseOptions);
    await Runner.manifestRelease(manifest);
  } else {
    const ghr = factory.githubRelease(releaseOptions);
    await Runner.releaser(ghr);
  }
}

/**
 * Returns the repository's default/primary branch.
 *
 * @param {string} owner owner portion of GitHub repo URL.
 * @param {string} repo repo portion of GitHub repo URL.
 * @param {object} octokit authenticated Octokit instance.
 * @returns {string}
 */
async function getConfigWithDefaultBranch(
  owner: string,
  repo: string,
  octokit: OctokitType
): Promise<ConfigurationOptions | null> {
  const config = await getConfig<ConfigurationOptions>(
    octokit,
    owner,
    repo,
    WELL_KNOWN_CONFIGURATION_FILE,
    {schema: schema}
  );
  if (config && !config.primaryBranch) {
    config.primaryBranch = await api.getRepositoryDefaultBranch(
      owner,
      repo,
      octokit
    );
  }
  return config;
}

/**
 * Returns the repository's default/primary branch.
 *
 * @param {string} owner owner portion of GitHub repo URL.
 * @param {string} repo repo portion of GitHub repo URL.
 * @param {object} octokit authenticated Octokit instance.
 * @returns {string}
 */
async function getRepositoryDefaultBranch(
  owner: string,
  repo: string,
  octokit: OctokitType
) {
  const {data} = await octokit.repos.get({
    owner,
    repo,
  });
  return (
    data as {
      default_branch: string;
    }
  ).default_branch;
}

async function createReleasePR(
  repoName: string,
  repoUrl: string,
  repoLanguage: string | null,
  configuration: BranchConfiguration,
  github: GitHubAPI,
  snapshot?: boolean
): Promise<ReleasePR | Manifest> {
  const releaseType = configuration.releaseType
    ? configuration.releaseType
    : configuration.manifest
    ? 'simple'
    : releaseTypeFromRepoLanguage(repoLanguage);
  const packageName = configuration.packageName || repoName;

  const buildOptions: ReleasePRFactoryOptions = {
    defaultBranch: configuration.branch,
    packageName,
    repoUrl,
    apiUrl: DEFAULT_API_URL,
    octokitAPIs: {
      octokit: github as {} as OctokitType,
      graphql: github.graphql,
      request: github.request,
    },
    bumpMinorPreMajor: configuration.bumpMinorPreMajor,
    path: configuration.path,
    monorepoTags: configuration.monorepoTags,
    releaseType,
    extraFiles: configuration.extraFiles,
  };
  if (snapshot !== undefined) {
    buildOptions.snapshot = snapshot;
  }
  if (configuration.releaseLabels) {
    buildOptions.label = configuration.releaseLabels.join(',');
  }

  if (configuration.manifest) {
    const manifest = factory.manifest(buildOptions);
    await Runner.manifest(manifest);
    return manifest;
  } else {
    const releasePR = factory.releasePR(buildOptions);
    await Runner.runner(releasePR);
    return releasePR;
  }
}

const handler = (app: Probot) => {
  app.on('push', async context => {
    const repoUrl = context.payload.repository.full_name;
    const branch = context.payload.ref.replace('refs/heads/', '');
    const repoName = context.payload.repository.name;
    const repoLanguage = context.payload.repository.language;
    const {owner, repo} = context.repo();

    const remoteConfiguration = await getConfigWithDefaultBranch(
      owner,
      repo,
      context.octokit
    );

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    const configuration = {
      ...DEFAULT_CONFIGURATION,
      ...remoteConfiguration,
    };

    const branchConfiguration = findBranchConfiguration(branch, configuration);
    if (!branchConfiguration) {
      logger.info(`Did not find configuration for branch: ${branch}`);
      return;
    }

    // use gcf-logger as logger for release-please
    setLogger(logger);

    logger.info(`push (${repoUrl})`);
    try {
      await createReleasePR(
        repoName,
        repoUrl,
        repoLanguage,
        branchConfiguration,
        context.octokit as GitHubAPI,
        undefined
      );
    } catch (e) {
      if (e instanceof Errors.ConfigurationError) {
        // In the future, this could raise an issue against the
        // installed repository
        logger.warn(e);
        return;
      } else {
        // re-raise
        throw e;
      }
    }

    // release-please can handle creating a release on GitHub, we opt not to do
    // this for our repos that have autorelease enabled.
    if (branchConfiguration.handleGHRelease) {
      logger.info(`handling GitHub release for (${repoUrl})`);
      try {
        await createGitHubRelease(
          branchConfiguration.packageName ?? repoName,
          repoUrl,
          branchConfiguration,
          context.octokit as GitHubAPI
        );
      } catch (e) {
        if (e instanceof Errors.DuplicateReleaseError) {
          // In the future, this could raise an issue against the
          // installed repository
          logger.warn('Release tag already exists, skipping...', e);
        } else {
          throw e;
        }
      }
    }
  });

  // See: https://github.com/octokit/webhooks.js/issues/277
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.on('schedule.repository' as any, async context => {
    const repoUrl = context.payload.repository.full_name;
    const owner = context.payload.organization.login;
    const repoName = context.payload.repository.name;

    const remoteConfiguration = await getConfigWithDefaultBranch(
      owner,
      repoName,
      context.octokit
    );

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    // syncLabels is just a nice to have feature, so we ignore all the
    // errors and continue. If this strategy becomes problematic, we
    // can create another scheduler job.
    try {
      await syncLabels(context.octokit, owner, repoName, RELEASE_PLEASE_LABELS);
    } catch (e) {
      const err = e as Error;
      err.message = `Failed to sync the labels: ${err.message}`;
      logger.error(err);
    }

    const configuration = {
      ...DEFAULT_CONFIGURATION,
      ...remoteConfiguration,
    };

    // use gcf-logger as logger for release-please
    setLogger(logger);

    logger.info(
      `schedule.repository (${repoUrl}, ${configuration.primaryBranch})`
    );
    const defaultBranchConfiguration = {
      ...configuration,
      ...{branch: configuration.primaryBranch},
    };

    // get the repository language
    const repository = await context.octokit.repos.get(context.repo());
    const repoLanguage = repository.data.language;

    await createReleasePR(
      repoName,
      repoUrl,
      repoLanguage,
      defaultBranchConfiguration,
      context.octokit as GitHubAPI,
      true
    );

    if (!configuration.branches) {
      return;
    }

    await Promise.all(
      configuration.branches.map(branchConfiguration => {
        logger.info(
          `schedule.repository (${repoUrl}, ${branchConfiguration.branch})`
        );
        return createReleasePR(
          repoName,
          repoUrl,
          repoLanguage,
          branchConfiguration,
          context.octokit as GitHubAPI,
          true
        );
      })
    );
  });

  app.on('pull_request.labeled', async context => {
    // if missing the label, skip
    if (
      // See: https://github.com/probot/probot/issues/1366
      !context.payload.pull_request.labels.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (label: any) => label.name === FORCE_RUN_LABEL
      )
    ) {
      logger.info(
        `ignoring non-force label action (${context.payload.pull_request.labels
          .map(label => {
            return label.name;
          })
          .join(', ')})`
      );
      return;
    }

    const repoUrl = context.payload.repository.full_name;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const branch = context.payload.pull_request.base.ref;
    const repoName = context.payload.repository.name;
    const repoLanguage = context.payload.repository.language;

    // remove the label
    await context.octokit.issues.removeLabel({
      name: FORCE_RUN_LABEL,
      issue_number: context.payload.pull_request.number,
      owner,
      repo,
    });

    // check release please config
    const remoteConfiguration = await getConfigWithDefaultBranch(
      owner,
      repoName,
      context.octokit
    );

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    const configuration = {
      ...DEFAULT_CONFIGURATION,
      ...remoteConfiguration,
    };

    const branchConfiguration = findBranchConfiguration(branch, configuration);
    if (!branchConfiguration) {
      logger.info(`Did not find configuration for branch: ${branch}`);
      return;
    }

    logger.info(`pull_request.labeled (${repoUrl})`);
    await createReleasePR(
      repoName,
      repoUrl,
      repoLanguage,
      branchConfiguration,
      context.octokit as GitHubAPI,
      undefined
    );
  });

  app.on('release.created', async context => {
    const repoUrl = context.payload.repository.full_name;
    const {owner, repo} = context.repo();
    const remoteConfiguration = await getConfig<ConfigurationOptions>(
      context.octokit,
      owner,
      repo,
      WELL_KNOWN_CONFIGURATION_FILE,
      {schema: schema}
    );

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    // Releases are still currently handled by autorelease, we hook into the
    // release.created webhook just to log this metric:
    logger.metric('release_please.release_created', {
      url: context.payload.repository.releases_url,
    });
  });
  // Check the config schema on PRs.
  app.on(['pull_request.opened', 'pull_request.synchronize'], async context => {
    const configChecker = new ConfigChecker<ConfigurationOptions>(
      schema,
      WELL_KNOWN_CONFIGURATION_FILE
    );
    const {owner, repo} = context.repo();
    await configChecker.validateConfigChanges(
      context.octokit,
      owner,
      repo,
      context.payload.pull_request.head.sha,
      context.payload.pull_request.number
    );
  });

  // If a release PR is closed unmerged, label with autorelease: closed
  app.on('pull_request.closed', async context => {
    const repoUrl = context.payload.repository.full_name;
    const {owner, repo} = context.repo();
    const remoteConfiguration = await getConfig<ConfigurationOptions>(
      context.octokit,
      owner,
      repo,
      WELL_KNOWN_CONFIGURATION_FILE,
      {schema: schema}
    );

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    if (context.payload.pull_request.merged) {
      logger.info('ignoring merged pull request');
      return;
    }

    if (
      context.payload.pull_request.labels.some(label => {
        return label.name === 'autorelease: pending';
      })
    ) {
      await Promise.all([
        context.octokit.issues.removeLabel(
          context.repo({
            issue_number: context.payload.pull_request.number,
            name: 'autorelease: pending',
          })
        ),
        context.octokit.issues.addLabels(
          context.repo({
            issue_number: context.payload.pull_request.number,
            labels: ['autorelease: closed'],
          })
        ),
      ]);
    }
  });

  // If a closed release PR is reopened, re-label with autorelease: pending
  app.on('pull_request.reopened', async context => {
    const repoUrl = context.payload.repository.full_name;
    const {owner, repo} = context.repo();
    const remoteConfiguration = await getConfig<ConfigurationOptions>(
      context.octokit,
      owner,
      repo,
      WELL_KNOWN_CONFIGURATION_FILE,
      {schema: schema}
    );

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    if (
      context.payload.pull_request.labels.some(label => {
        return label.name === 'autorelease: closed';
      })
    ) {
      await Promise.all([
        context.octokit.issues.removeLabel(
          context.repo({
            issue_number: context.payload.pull_request.number,
            name: 'autorelease: closed',
          })
        ),
        context.octokit.issues.addLabels(
          context.repo({
            issue_number: context.payload.pull_request.number,
            labels: ['autorelease: pending'],
          })
        ),
      ]);
    }
  });
};

export const api = {
  handler,
  getRepositoryDefaultBranch,
};
