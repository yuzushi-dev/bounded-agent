import { createOmpAdapter } from '../adapters/omp.mjs';
import {
  defaultManifestPath,
  loadInstallationManifest,
  loadInstalledComposition,
  validateInstallationManifest,
} from './installation.mjs';

export { defaultManifestPath, loadInstallationManifest, loadInstalledComposition, validateInstallationManifest };

export function registerBoundedAutonomy(pi, { controller, hostAdmissionDefaults, loadHostAdmissionDefaults }) {
  createOmpAdapter(controller, { hostAdmissionDefaults, loadHostAdmissionDefaults }).register(pi);
}

export function createBoundedAutonomyExtension({ loadController, hostAdmissionDefaults }) {
  if (typeof loadController !== 'function') throw new Error('bounded controller loader is required');
  let pending;
  async function load() {
    pending ??= Promise.resolve().then(loadController).catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  }
  const resolvedController = async () => {
    const composition = await load();
    return composition?.controller ?? composition;
  };
  const controller = Object.fromEntries(
    ['admit', 'discard', 'run', 'status', 'rollback', 'doctor'].map((name) => [name, async (...args) => {
      const composition = await resolvedController();
      if (typeof composition?.[name] !== 'function') throw new Error('bounded installation composition is invalid');
      return composition[name](...args);
    }]),
  );
  const loadHostAdmissionDefaults = hostAdmissionDefaults === undefined
    ? async () => (await load())?.hostAdmissionDefaults
    : undefined;
  return (pi) => registerBoundedAutonomy(pi, { controller, hostAdmissionDefaults, loadHostAdmissionDefaults });
}

export default createBoundedAutonomyExtension({
  loadController: async () => loadInstalledComposition(),
});
