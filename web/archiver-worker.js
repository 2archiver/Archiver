// Same-origin, version-pinned runtime. Only model assets use external hosts.
import { WebWorkerMLCEngineHandler } from './vendor/web-llm-0.2.80.js';
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = event => handler.onmessage(event);
