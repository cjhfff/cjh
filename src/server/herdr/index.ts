export {
  HerdrClient,
  HerdrRpcError,
  HerdrUnavailableError,
  deriveTerminalAgent,
  resolveAgentArgv,
  resolveHerdrExecutablePath,
  type HerdrClientOptions
} from './client'
export { registerHerdrRoutes, type HerdrRouteDeps } from './routes'
export {
  HerdrNotifier,
  extractScreenTail,
  parseScreenOptions,
  stripAnsi
} from './notifier'
export { HerdrFollowManager, type HerdrFollowEngineTrigger } from './follow'
