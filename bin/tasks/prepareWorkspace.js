import { isClean, isUpToDate, getUpdateMessage, findMergeBase, checkout } from '../git/git';
import installDependencies from '../lib/installDependencies';
import {
  initial,
  pending,
  lookupMergeBase,
  checkoutMergeBase,
  installingDependencies,
  success,
} from '../ui/tasks/prepareWorkspace';
import mergeBaseNotFound from '../ui/messages/errors/mergeBaseNotFound';
import { createTask, transitionTo } from '../lib/tasks';
import workspaceNotClean from '../ui/messages/errors/workspaceNotClean';
import workspaceNotUpToDate from '../ui/messages/errors/workspaceNotUpToDate';
import { runRestoreWorkspace } from './restoreWorkspace';

const prepareWorkspace = async (ctx, task) => {
  const { patchHeadRef, patchBaseRef } = ctx.options;

  // Make sure the git repo is in a clean state (no changes / untracked files).
  if (!(await isClean())) {
    ctx.exitCode = 101;
    ctx.userError = true;
    ctx.log.error(workspaceNotClean());
    throw new Error('Working directory is not clean');
  }

  // Make sure both the head and base branches are up-to-date with the remote.
  if (!(await isUpToDate())) {
    ctx.exitCode = 102;
    ctx.userError = true;
    ctx.log.error(workspaceNotUpToDate(await getUpdateMessage()));
    throw new Error('Workspace not up-to-date with remote');
  }

  transitionTo(lookupMergeBase)(ctx, task);

  // Get the merge base commit hash.
  ctx.mergeBase = await findMergeBase(patchHeadRef, patchBaseRef);
  if (!ctx.mergeBase) {
    ctx.exitCode = 103;
    ctx.userError = true;
    ctx.log.error(mergeBaseNotFound(ctx.options));
    throw new Error('Could not find a merge base');
  }

  transitionTo(checkoutMergeBase)(ctx, task);
  await checkout(ctx.mergeBase);

  try {
    transitionTo(installingDependencies)(ctx, task);
    await installDependencies(); // this might modify a lockfile
  } catch (err) {
    ctx.exitCode = 104;
    ctx.log.error(err);
    await runRestoreWorkspace(); // make sure we clean up even when something breaks
    throw new Error('Failed to install dependencies');
  }
};

export default createTask({
  title: initial.title,
  steps: [transitionTo(pending), prepareWorkspace, transitionTo(success, true)],
});
