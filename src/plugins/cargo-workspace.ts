// Copyright 2021 Google LLC
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

import {CandidateReleasePullRequest, ROOT_PROJECT_PATH} from '../manifest';
import {
  WorkspacePlugin,
  DependencyGraph,
  DependencyNode,
  addPath,
  appendDependenciesSectionToChangelog,
} from './workspace';
import {
  CargoManifest,
  parseCargoManifest,
  CargoDependencies,
  CargoDependency,
  TargetDependencies,
} from '../updaters/rust/common';
import {VersionsMap, Version} from '../version';
import {CargoToml} from '../updaters/rust/cargo-toml';
import {RawContent} from '../updaters/raw-content';
import {Changelog} from '../updaters/changelog';
import {ReleasePullRequest} from '../release-pull-request';
import {PullRequestTitle} from '../util/pull-request-title';
import {PullRequestBody} from '../util/pull-request-body';
import {BranchName} from '../util/branch-name';
import {PatchVersionUpdate} from '../versioning-strategy';
import {CargoLock} from '../updaters/rust/cargo-lock';
import {ConfigurationError} from '../errors';
import {GitHubFileContents} from '@google-automations/git-file-utils';
import {Commit} from '../commit';
import {Release} from '../release';

interface CrateInfo {
  /**
   * e.g. `crates/crate-a`
   */
  path: string;

  /**
   * e.g. `crate-a`
   */
  name: string;

  /**
   * e.g. `1.0.0`
   */
  version: string;

  /**
   * e.g. `crates/crate-a/Cargo.toml`
   */
  manifestPath: string;

  /**
   * text content of the manifest, used for updates
   */
  manifestContent: string;

  /**
   * Parsed cargo manifest
   */
  manifest: CargoManifest;
}

// TODO: Should also take workspace-level feature flag changes into account
function workspaceDependencyVersionMap(
  cargoWorkspaceManifest: CargoManifest
): Record<string, string> {
  const dependencies = cargoWorkspaceManifest.workspace?.dependencies;

  if (!dependencies) {
    return {};
  }

  return Object.keys(dependencies)
    .map((key => {
      const dependency = dependencies[key];
      if (typeof dependency === 'string') {
        return [key, dependency];
      } else {
        return [key, (dependency as CargoDependency).version];
      }
    }) as (key: string) => [string, string | undefined])
    .filter<[string, string]>(
      (depVersion => typeof depVersion[1] === 'string') as (
        value: [string, string | undefined]
      ) => value is [string, string]
    )
    .reduce<Record<string, string>>((initial, next) => {
      initial[next[0]] = next[1];
      return initial;
    }, {});
}

function mapCommitsToShas(commits: Commit[]): Record<string, Commit> {
  return commits.reduce((shaCommits, commit) => {
    shaCommits[commit.sha] = commit;
    return shaCommits;
  }, {} as Record<string, Commit>);
}

function zipCommitsInHistoryOrder(
  left: Commit[],
  right: Commit[],
  history: Commit[]
) {
  const leftShas = mapCommitsToShas(left);
  const rightShas = mapCommitsToShas(right);
  const zippedCommits: Commit[] = [];

  for (const commit of history) {
    const nextCommit = leftShas[commit.sha] || rightShas[commit.sha];
    if (nextCommit) {
      zippedCommits.push(nextCommit);
    }
  }
  return zippedCommits;
}

/**
 * The plugin analyzed a cargo workspace and will bump dependencies
 * of managed packages if those dependencies are being updated.
 *
 * If multiple rust packages are being updated, it will merge them
 * into a single rust package.
 */
export class CargoWorkspace extends WorkspacePlugin<CrateInfo> {
  protected workspaceCargoManifestContents: GitHubFileContents | null = null;
  protected workspaceCargoManifest: CargoManifest | null = null;

  protected async getWorkspaceCargoManifestContent(): Promise<GitHubFileContents> {
    this.workspaceCargoManifestContents =
      this.workspaceCargoManifestContents ||
      (await this.getWorkspaceCargoManifestContentAtBranchOrSha(
        this.targetBranch
      ));
    return this.workspaceCargoManifestContents;
  }

  protected async getWorkspaceCargoManifest(): Promise<CargoManifest> {
    this.workspaceCargoManifest =
      this.workspaceCargoManifest ||
      parseCargoManifest(
        (await this.getWorkspaceCargoManifestContent()).parsedContent
      );
    return this.workspaceCargoManifest;
  }

  protected async getWorkspaceCargoManifestContentAtBranchOrSha(
    branchOrSha: string
  ): Promise<GitHubFileContents> {
    return await this.github.getFileContentsOnBranch('Cargo.toml', branchOrSha);
  }

  protected async getWorkspaceCargoManifestAtBranchOrSha(
    branchOrSha: string
  ): Promise<CargoManifest> {
    this.logger.info(`Reading workspace Cargo manifest from '${branchOrSha}'`);

    return parseCargoManifest(
      (await this.getWorkspaceCargoManifestContentAtBranchOrSha(branchOrSha))
        .parsedContent
    );
  }

  async postProcessCommitsPerPath(
    commitsPerPath: Record<string, Commit[]>,
    releasesByPath: Record<string, Release>,
    allCommits: Commit[]
  ): Promise<Record<string, Commit[]>> {
    this.logger.info(
      `Post-processing ${allCommits.length} commits to look for relevant workspace manifest dependency changes...`
    );
    const workspaceCargoManifest = await this.getWorkspaceCargoManifest();
    const workspaceDependencies =
      workspaceCargoManifest.workspace?.dependencies;

    // If we don't have any workspace dependencies, we don't need to make any
    // changes
    if (!workspaceDependencies) {
      // No workspace dependencies; carry on...
      this.logger.info('No workspace-level dependencies found');
      return commitsPerPath;
    }

    const workspaceManifestCommitsByPath: Record<string, Commit[]> = {};

    for (const [path, release] of Object.entries(releasesByPath)) {
      if (release.sha) {
        this.logger.info(
          `Looking for ${path} release SHA ${release.sha} among all considered commits`
        );
        const pathHistoryStartIndex = allCommits.findIndex(
          commit => commit.sha === release.sha
        );
        if (pathHistoryStartIndex > -1) {
          this.logger.info(`Found SHA at ${pathHistoryStartIndex}..`);
          workspaceManifestCommitsByPath[path] = allCommits
            .slice(0, pathHistoryStartIndex)
            .reverse();
          continue;
        } else {
          this.logger.warn(
            `Last release SHA for ${path} (${release.sha}) did not occur in the set of all considered commits`
          );
        }
      } else {
        this.logger.warn(`Last release SHA for ${path} was not given!`);
      }
      workspaceManifestCommitsByPath[path] = [];
    }

    let hasWorkspaceManifestCommits = false;

    for (const [path, commits] of Object.entries(
      workspaceManifestCommitsByPath
    )) {
      workspaceManifestCommitsByPath[path] = commits.filter(commit =>
        commit.files?.includes('Cargo.toml')
      );
      if (workspaceManifestCommitsByPath[path].length > 0) {
        hasWorkspaceManifestCommits = true;
      }
    }

    // Make sure the workspace manifest was actually updated before proceding
    if (!hasWorkspaceManifestCommits) {
      this.logger.info('No commits have touched the workspace manifest');
      // No commits to the workspace manifest, so cut out early
      return commitsPerPath;
    }

    // Walk over all package paths with commits associated with them, read their
    // manifests, and if they have workspace-inherited dependencies, compare the
    // workspace manifest from their last release to the one on the target
    // branch.
    for (const packagePath in commitsPerPath) {
      if (packagePath === ROOT_PROJECT_PATH) {
        // Ignore the workspace-level Cargo manifest
        continue;
      }

      const cargoManifestPath = addPath(packagePath, 'Cargo.toml');
      const cargoManifestContents = await this.github.getFileContentsOnBranch(
        cargoManifestPath,
        this.targetBranch
      );
      const cargoManifest = parseCargoManifest(
        cargoManifestContents.parsedContent
      );

      let packageDependencies = Object.entries(
        cargoManifest.dependencies ?? {}
      );
      for (const [_, targetScope] of Object.entries(
        cargoManifest.target ?? {}
      )) {
        packageDependencies = packageDependencies.concat(
          Object.entries(targetScope.dependencies ?? {})
        );
      }

      if (!packageDependencies) {
        this.logger.info(
          `Crate at ${packagePath} has no dependencies, skipping workspace dependency check...`
        );
        // No chance of workspace dependencies if there no dependencies at all
        continue;
      }

      // Get all the dependencies in the latest package manifest that are inherited
      // from the workspace
      const packageWorkspaceDependencies = packageDependencies
        .filter(
          (([_, dependency]) =>
            typeof dependency !== 'string' &&
            dependency.workspace === true) as (
            value: [string, string | CargoDependency]
          ) => value is [string, CargoDependency & {workspace: true}]
        )
        .reduce((record, [name, dependency]) => {
          record[name] = dependency;
          return record;
        }, {} as Record<string, CargoDependency & {workspace: true}>);

      if (Object.keys(packageWorkspaceDependencies).length === 0) {
        this.logger.info(
          `Crate at ${packagePath} does not inherit workspace dependencies, skipping workspace dependency check...`
        );
        // No workspace dependencies found in this package
        continue;
      }

      const previousRelease = releasesByPath[packagePath];

      if (!previousRelease) {
        this.logger.info(
          `Crate at ${packagePath} has not been released previously, skipping workspace dependency check...`
        );
        // No prior release for this package, so I guess we can skip?
        continue;
      }

      // Get the workspace dependency versions as of the last release of this
      // package
      let previousWorkspaceDependencyVersions: Record<string, string> = {};

      try {
        this.logger.info(
          `Attempting to find Cargo manifest for last release of ${packagePath} (${previousRelease.tag.toString()})`
        );
        previousWorkspaceDependencyVersions = workspaceDependencyVersionMap(
          await this.getWorkspaceCargoManifestAtBranchOrSha(
            previousRelease.tag.toString()
          )
        );
      } catch (_) {
        this.logger.warn(
          `No workspace Cargo manifest found for the last release of ${packagePath}`
        );
      }

      const workspaceManifestCommits =
        workspaceManifestCommitsByPath[packagePath];
      const extraCommitsToIncludeForPath: Commit[] = [];

      // Walk the workspace commits that preceed each path's latest commit
      // and check them one at a time for version changes
      for (const commit of workspaceManifestCommits) {
        // TODO: Optimize by doing this once for whole list of commits
        const nextWorkspaceDependencyVersions = workspaceDependencyVersionMap(
          await this.getWorkspaceCargoManifestAtBranchOrSha(commit.sha)
        );

        for (const dependencyName in packageWorkspaceDependencies) {
          this.logger.info(
            `Checking workspace dependency '${dependencyName}' for ${packagePath}`
          );

          const previousWorkspaceDependency =
            previousWorkspaceDependencyVersions[dependencyName];
          const nextWorkspaceDependency =
            nextWorkspaceDependencyVersions[dependencyName];

          // NOTE: If either of these dependencies isn't in their respective
          // maps, it means that the workspace-level dependency was just added
          // or just removed.

          // TODO: Should compare features as well to see if they changed
          const dependencyChanged =
            previousWorkspaceDependency !== nextWorkspaceDependency;

          if (dependencyChanged) {
            const previousVersion =
              previousWorkspaceDependency || 'not present';
            const nextVersion = nextWorkspaceDependency || 'not present';

            this.logger.info(
              `Commit ${commit.sha} includes a workspace dependency change that affects ${packagePath} ('${dependencyName}' changed from ${previousVersion} to ${nextVersion})`
            );
            extraCommitsToIncludeForPath.push(commit);
            // Break so that we only include this commit once; other deps may
            // have impacted this package too, but we only need to check for one
            // to include the commit.
            break;
          }
        }

        previousWorkspaceDependencyVersions = nextWorkspaceDependencyVersions;
      }

      if (extraCommitsToIncludeForPath.length) {
        this.logger.info(
          `Found ${extraCommitsToIncludeForPath.length} extra commits that change workspace dependency versions relevant to ${packagePath}`
        );
        // We found relevant commits to the workspace manifest, so zip them with
        // the package path-scoped commits in (presumably) history order
        commitsPerPath[packagePath] = zipCommitsInHistoryOrder(
          commitsPerPath[packagePath],
          extraCommitsToIncludeForPath,
          allCommits
        );
      } else {
        this.logger.info(
          `No commits to the workspace manifest affect ${packagePath}`
        );
      }
    }

    return commitsPerPath;
  }

  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<{
    allPackages: CrateInfo[];
    candidatesByPackage: Record<string, CandidateReleasePullRequest>;
  }> {
    const workspaceCargoManifest = await this.getWorkspaceCargoManifest();

    if (!workspaceCargoManifest.workspace?.members) {
      this.logger.warn(
        "cargo-workspace plugin used, but top-level Cargo.toml isn't a cargo workspace"
      );
      return {allPackages: [], candidatesByPackage: {}};
    }

    const allCrates: CrateInfo[] = [];
    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};

    const members = (
      await Promise.all(
        workspaceCargoManifest.workspace.members.map(member =>
          this.github.findFilesByGlobAndRef(member, this.targetBranch)
        )
      )
    ).flat();
    members.push(ROOT_PROJECT_PATH);

    for (const path of members) {
      const manifestPath = addPath(path, 'Cargo.toml');
      this.logger.info(`looking for candidate with path: ${path}`);
      const candidate = candidates.find(c => c.path === path);
      // get original content of the crate
      const manifestContent =
        candidate?.pullRequest.updates.find(
          update => update.path === manifestPath
        )?.cachedFileContents ||
        (await this.github.getFileContentsOnBranch(
          manifestPath,
          this.targetBranch
        ));
      const manifest = parseCargoManifest(manifestContent.parsedContent);
      const packageName = manifest.package?.name;
      if (!packageName) {
        this.logger.warn(
          `package manifest at ${manifestPath} is missing [package.name]`
        );
        continue;
      }
      if (candidate) {
        candidatesByPackage[packageName] = candidate;
      }

      const version = manifest.package?.version;
      if (!version) {
        throw new ConfigurationError(
          `package manifest at ${manifestPath} is missing [package.version]`,
          'cargo-workspace',
          `${this.github.repository.owner}/${this.github.repository.repo}`
        );
      } else if (typeof version !== 'string') {
        throw new ConfigurationError(
          `package manifest at ${manifestPath} has an invalid [package.version]`,
          'cargo-workspace',
          `${this.github.repository.owner}/${this.github.repository.repo}`
        );
      }
      // CDATA: Check manifest for workspace dependencies and note deltas
      // here in the "CrateInfo"
      allCrates.push({
        path,
        name: packageName,
        version,
        manifest,
        manifestContent: manifestContent.parsedContent,
        manifestPath,
      });
    }
    return {
      allPackages: allCrates,
      candidatesByPackage,
    };
  }

  protected bumpVersion(pkg: CrateInfo): Version {
    const version = Version.parse(pkg.version);
    return new PatchVersionUpdate().bump(version);
  }

  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    pkg: CrateInfo,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const version = updatedVersions.get(pkg.name);
    if (!version) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }
    const updater = new CargoToml({
      version,
      versionsMap: updatedVersions,
    });
    const updatedContent = updater.updateContent(pkg.manifestContent);
    const originalManifest = parseCargoManifest(pkg.manifestContent);
    const updatedManifest = parseCargoManifest(updatedContent);
    const dependencyNotes = getChangelogDepsNotes(
      originalManifest,
      updatedManifest
    );

    existingCandidate.pullRequest.updates =
      existingCandidate.pullRequest.updates.map(update => {
        if (update.path === addPath(existingCandidate.path, 'Cargo.toml')) {
          update.updater = new RawContent(updatedContent);
        } else if (update.updater instanceof Changelog && dependencyNotes) {
          update.updater.changelogEntry = appendDependenciesSectionToChangelog(
            update.updater.changelogEntry,
            dependencyNotes,
            this.logger
          );
        } else if (
          update.path === addPath(existingCandidate.path, 'Cargo.lock')
        ) {
          update.updater = new CargoLock(updatedVersions);
        }
        return update;
      });

    // append dependency notes
    if (dependencyNotes) {
      if (existingCandidate.pullRequest.body.releaseData.length > 0) {
        existingCandidate.pullRequest.body.releaseData[0].notes =
          appendDependenciesSectionToChangelog(
            existingCandidate.pullRequest.body.releaseData[0].notes,
            dependencyNotes,
            this.logger
          );
      } else {
        existingCandidate.pullRequest.body.releaseData.push({
          component: pkg.name,
          version: existingCandidate.pullRequest.version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        });
      }
    }
    return existingCandidate;
  }

  protected newCandidate(
    pkg: CrateInfo,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const version = updatedVersions.get(pkg.name);
    if (!version) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }
    const updater = new CargoToml({
      version,
      versionsMap: updatedVersions,
    });
    const updatedContent = updater.updateContent(pkg.manifestContent);
    const originalManifest = parseCargoManifest(pkg.manifestContent);
    const updatedManifest = parseCargoManifest(updatedContent);
    const dependencyNotes = getChangelogDepsNotes(
      originalManifest,
      updatedManifest
    );
    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {
          component: pkg.name,
          version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        },
      ]),
      updates: [
        {
          path: addPath(pkg.path, 'Cargo.toml'),
          createIfMissing: false,
          updater: new RawContent(updatedContent),
        },
        {
          path: addPath(pkg.path, 'CHANGELOG.md'),
          createIfMissing: false,
          updater: new Changelog({
            version,
            changelogEntry: dependencyNotes,
          }),
        },
      ],
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version,
      draft: false,
    };
    return {
      path: pkg.path,
      pullRequest,
      config: {
        releaseType: 'rust',
      },
    };
  }

  protected postProcessCandidates(
    candidates: CandidateReleasePullRequest[],
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest[] {
    let rootCandidate = candidates.find(c => c.path === ROOT_PROJECT_PATH);
    if (!rootCandidate) {
      this.logger.warn('Unable to find root candidate pull request');
      rootCandidate = candidates.find(c => c.config.releaseType === 'rust');
    }
    if (!rootCandidate) {
      this.logger.warn('Unable to find a rust candidate pull request');
      return candidates;
    }

    // Update the root Cargo.lock if it exists
    rootCandidate.pullRequest.updates.push({
      path: 'Cargo.lock',
      createIfMissing: false,
      updater: new CargoLock(updatedVersions),
    });

    return candidates;
  }

  protected async buildGraph(
    allPackages: CrateInfo[]
  ): Promise<DependencyGraph<CrateInfo>> {
    const workspaceCrateNames = new Set(
      allPackages.map(crateInfo => crateInfo.name)
    );
    const graph = new Map<string, DependencyNode<CrateInfo>>();
    for (const crateInfo of allPackages) {
      const allDeps = Object.keys({
        ...(crateInfo.manifest.dependencies ?? {}),
        ...(crateInfo.manifest['dev-dependencies'] ?? {}),
        ...(crateInfo.manifest['build-dependencies'] ?? {}),
      });

      const targets = crateInfo.manifest.target;
      if (targets) {
        for (const targetName in targets) {
          const target = targets[targetName];

          allDeps.push(
            ...Object.keys({
              ...(target.dependencies ?? {}),
              ...(target['dev-dependencies'] ?? {}),
              ...(target['build-dependencies'] ?? {}),
            })
          );
        }
      }

      const workspaceDeps = allDeps.filter(dep => workspaceCrateNames.has(dep));
      graph.set(crateInfo.name, {
        deps: workspaceDeps,
        value: crateInfo,
      });
    }
    return graph;
  }

  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'rust';
  }

  protected packageNameFromPackage(pkg: CrateInfo): string {
    return pkg.name;
  }

  protected pathFromPackage(pkg: CrateInfo): string {
    return pkg.path;
  }
}

function getChangelogDepsNotes(
  originalManifest: CargoManifest,
  updatedManifest: CargoManifest
): string {
  let depUpdateNotes = '';
  type DT = 'dependencies' | 'dev-dependencies' | 'build-dependencies';
  const depTypes: DT[] = [
    'dependencies',
    'dev-dependencies',
    'build-dependencies',
  ];
  const depVer = (
    s: string | CargoDependency | undefined
  ): string | undefined => {
    if (s === undefined) {
      return undefined;
    }
    if (typeof s === 'string') {
      return s;
    } else {
      return s.version;
    }
  };
  type DepMap = Record<string, string>;
  const getDepMap = (cargoDeps: CargoDependencies): DepMap => {
    const result: DepMap = {};
    for (const [key, val] of Object.entries(cargoDeps)) {
      const ver = depVer(val);
      if (ver) {
        result[key] = ver;
      }
    }
    return result;
  };

  type DepUpdates = Map<DT, Set<string>>;

  const populateUpdates = (
    originalScope: CargoManifest | TargetDependencies[string],
    updatedScope: CargoManifest | TargetDependencies[string],
    updates: DepUpdates
  ) => {
    for (const depType of depTypes) {
      const depUpdates = [];
      const pkgDepTypes = updatedScope[depType];

      if (pkgDepTypes === undefined) {
        continue;
      }
      for (const [depName, currentDepVer] of Object.entries(
        getDepMap(pkgDepTypes)
      )) {
        const origDepVer = depVer(originalScope[depType]?.[depName]);
        if (currentDepVer !== origDepVer) {
          depUpdates.push(
            `\n    * ${depName} bumped from ${origDepVer} to ${currentDepVer}`
          );
        }
      }
      if (depUpdates.length > 0) {
        const updatesForType = updates.get(depType) || new Set();
        depUpdates.forEach(update => updatesForType.add(update));
        updates.set(depType, updatesForType);
      }
    }
  };

  const updates: DepUpdates = new Map();

  populateUpdates(originalManifest, updatedManifest, updates);

  if (updatedManifest.target && originalManifest.target) {
    for (const targetName in updatedManifest.target) {
      populateUpdates(
        originalManifest.target[targetName],
        updatedManifest.target[targetName],
        updates
      );
    }
  }

  for (const [dt, notes] of updates) {
    depUpdateNotes += `\n  * ${dt}`;
    for (const note of notes) {
      depUpdateNotes += note;
    }
  }

  if (depUpdateNotes) {
    return `* The following workspace dependencies were updated${depUpdateNotes}`;
  }
  return '';
}
