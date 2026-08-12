import fs from 'node:fs';

const controller = await import(process.argv[2]);
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const options = { bundle: request.bundle, paths: request.paths };
const result = request.action === 'reconcile'
  ? controller.reconcilePromotion({ ...options, now: request.now })
  : controller.rollbackPromotion(options);
process.stdout.write(JSON.stringify(result));
