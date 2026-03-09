/**
 * Linked-table runtime host helpers.
 */

export function buildMonitorCliArgs({ docPath, syncUrl, projectRoot = null }) {
  const args = ['--doc', docPath];
  if (projectRoot) {
    args.push('--project-root', projectRoot);
  }
  args.push(syncUrl);
  return args;
}

export default {
  buildMonitorCliArgs,
};
