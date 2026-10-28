'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

/**
 * @param {number} nodeMajor - Node.js major version the module sees
 */
function loadRemoteConfig (nodeMajor) {
  return proxyquire('../../src/profiling/remote-config', { '../../../../version': { NODE_MAJOR: nodeMajor } })
}

// Most tests run against a Node.js version without allocation profiling, so that the set of mapped
// profile types doesn't depend on the version running them.
const { enable, PRODUCTS } = loadRemoteConfig(24)

describe('Profiling Remote Config', () => {
  let rc
  let config
  let handler
  let getRunningProfileTypes

  beforeEach(() => {
    handler = undefined
    rc = {
      subscribeProducts: sinon.spy(),
      setBatchHandler: sinon.spy((products, batchHandler) => {
        handler = batchHandler
      }),
    }
    config = {
      service: 'my-service',
      env: 'prod',
      tags: { team: 'profiling', region: 'eu' },
      setRemoteConfig: sinon.spy(),
    }
    // Unless a test says otherwise, every profile type already runs under local configuration, so
    // omitted fields keep their local values.
    getRunningProfileTypes = sinon.stub().returns(['wall', 'cpu', 'space', 'events'])
    // The fakes implement only what the handler uses.
    enable(
      /** @type {import('../../src/remote_config')} */ (/** @type {unknown} */ (rc)),
      /** @type {ReturnType<import('../../src/config')>} */ (/** @type {unknown} */ (config)),
      getRunningProfileTypes
    )
  })

  /**
   * @param {{ toApply?: object[], toModify?: object[], toUnapply?: object[] }} items
   */
  function update ({ toApply = [], toModify = [], toUnapply = [] }) {
    const addDefaults = ({ product = 'DEBUG', ...item }) => ({
      product,
      path: `datadog/2/${product}/${item.id}/config`,
      ...item,
    })
    const transaction = {
      toApply: toApply.map(addDefaults),
      toModify: toModify.map(addDefaults),
      toUnapply: toUnapply.map(addDefaults),
      ack: sinon.spy(),
      error: sinon.spy(),
    }
    handler(transaction)
    return transaction
  }

  // Current layer settings, or null before the first write.
  function currentSettings () {
    const { lastCall } = config.setRemoteConfig
    if (lastCall === null) return null
    assert.strictEqual(lastCall.args[1], 'profiling')
    return lastCall.args[0]
  }

  it('subscribes to the products with a batch handler', () => {
    assert.deepStrictEqual(PRODUCTS, ['DEBUG', 'APM_PROFILING'])
    sinon.assert.calledOnceWithExactly(rc.subscribeProducts, 'DEBUG', 'APM_PROFILING')
    sinon.assert.calledOnceWithExactly(rc.setBatchHandler, ['DEBUG', 'APM_PROFILING'], sinon.match.func)
  })

  it('subscribes only to DEBUG in agentless mode', () => {
    const agentlessRc = { subscribeProducts: sinon.spy(), setBatchHandler: sinon.spy() }
    enable(
      /** @type {import('../../src/remote_config')} */ (/** @type {unknown} */ (agentlessRc)),
      /** @type {ReturnType<import('../../src/config')>} */ (/** @type {unknown} */ (
        { ...config, DD_AGENTLESS_ENABLED: true }
      )),
      getRunningProfileTypes
    )

    sinon.assert.calledOnceWithExactly(agentlessRc.subscribeProducts, 'DEBUG')
    sinon.assert.calledOnceWithExactly(agentlessRc.setBatchHandler, ['DEBUG'], sinon.match.func)
  })

  it('merges configs from both products', () => {
    update({
      toApply: [
        { id: 'a', file: { profilers: { heapSize: true } } },
        { product: 'APM_PROFILING', id: 'b', file: { profilers: { wallTime: false } } },
      ],
    })

    assert.deepStrictEqual(currentSettings(), {
      DD_PROFILING_WALLTIME_ENABLED: 'false',
      DD_PROFILING_HEAP_ENABLED: 'true',
      DD_PROFILING_ENABLED: 'true',
    })
  })

  it('keeps configs with the same id in different products apart', () => {
    update({
      toApply: [
        { id: 'a', file: { profilers: { heapSize: true } } },
        { product: 'APM_PROFILING', id: 'a', file: { profilers: { wallTime: false } } },
      ],
    })
    update({ toUnapply: [{ id: 'a' }] })

    assert.deepStrictEqual(currentSettings(), { DD_PROFILING_WALLTIME_ENABLED: 'false' })
  })

  describe('profile types that are not running locally', () => {
    it('turns off omitted profile types when turning profiling on from a stopped profiler', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('keeps omitted profile types that run locally and turns off the ones that do not', () => {
      getRunningProfileTypes.returns(['space'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('still runs the wall profiler for requested CPU time', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('does not turn off omitted profile types when the payload does not turn profiling on', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'false' })
    })

    it('ignores running profiler types that serve no mapped profile type', () => {
      getRunningProfileTypes.returns(['events'])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })

      assert.strictEqual(currentSettings().DD_PROFILING_WALLTIME_ENABLED, 'false')
    })

    it('captures the local profile types once, at the first profiling content', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })
      sinon.assert.notCalled(getRunningProfileTypes)

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      sinon.assert.calledOnce(getRunningProfileTypes)

      // The profiler now runs what remote config asked for; that must not count as local state.
      getRunningProfileTypes.returns(['space', 'wall', 'cpu'])
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: true, wallTime: true } } }] })

      sinon.assert.calledOnce(getRunningProfileTypes)
      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })
  })

  describe('allocations', () => {
    /**
     * @param {number} nodeMajor - Node.js major version the module sees
     */
    function enableOn (nodeMajor) {
      loadRemoteConfig(nodeMajor).enable(
        /** @type {import('../../src/remote_config')} */ (/** @type {unknown} */ (rc)),
        /** @type {ReturnType<import('../../src/config')>} */ (/** @type {unknown} */ (config)),
        getRunningProfileTypes
      )
    }

    it('maps allocations and runs the heap profiler for them on Node.js 26 and later', () => {
      enableOn(26)

      update({ toApply: [{ id: 'a', file: { profilers: { allocations: true, heapSize: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ALLOCATION_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('turns off allocations that were not running locally when turning profiling on', () => {
      enableOn(26)
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ALLOCATION_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('keeps allocations that were running locally', () => {
      enableOn(26)
      getRunningProfileTypes.returns(['space', 'allocations'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('needs allocations turned off as well to disable profiling', () => {
      enableOn(26)

      const allButAllocations = { cpuTime: false, wallTime: false, heapSize: false, heapObjects: false }
      update({ toApply: [{ id: 'a', file: { profilers: allButAllocations } }] })
      assert.strictEqual(currentSettings().DD_PROFILING_ENABLED, undefined)

      update({ toModify: [{ id: 'a', file: { profilers: { ...allButAllocations, allocations: false } } }] })
      assert.strictEqual(currentSettings().DD_PROFILING_ENABLED, 'false')
    })

    it('ignores allocations before Node.js 26', () => {
      enableOn(25)

      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { allocations: true } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })
  })

  describe('updates', () => {
    it('does not touch the profiling layer for payloads of other DEBUG users', () => {
      update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })
      update({ toModify: [{ id: 'other-team', file: { something: 'different' } }] })
      update({ toUnapply: [{ id: 'other-team' }] })

      sinon.assert.notCalled(config.setRemoteConfig)
    })

    it('does not touch the profiling layer when the merged settings are unchanged', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      sinon.assert.calledOnce(config.setRemoteConfig)

      update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: true }, targets: [{ env: 'prod' }] } }] })
      update({ toApply: [{ id: 'b', file: { profilers: { heapSize: true } } }] })

      sinon.assert.calledOnce(config.setRemoteConfig)
    })

    it('writes the profiling layer again once the merged settings change', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: false } } }] })
      update({ toUnapply: [{ id: 'a' }] })

      sinon.assert.calledThrice(config.setRemoteConfig)
      assert.deepStrictEqual(
        config.setRemoteConfig.secondCall.args,
        [{ DD_PROFILING_HEAP_ENABLED: 'false' }, 'profiling']
      )
      assert.deepStrictEqual(config.setRemoteConfig.thirdCall.args, [null, 'profiling'])
    })
  })

  describe('heap objects', () => {
    it('runs the heap profiler for heap objects even when heap size is turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapObjects: true, heapSize: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('runs the heap profiler for heap size even when heap objects are turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true, heapObjects: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('turns off the heap profiler when either is turned off and neither is requested', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapObjects: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'false' })
    })

    it('counts a locally running heap profiler as running heap objects', () => {
      getRunningProfileTypes.returns(['space'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('reports heap objects that are not a boolean', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { heapObjects: 1 } } }] })

      sinon.assert.calledOnceWithExactly(
        transaction.error,
        'datadog/2/DEBUG/a/config',
        'profilers.heapObjects is not a boolean'
      )
    })
  })

  describe('mapping', () => {
    it('maps each requested profile type and enables profiling', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true, wallTime: true, heapSize: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('runs the wall profiler for CPU time even when wall time is turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true, wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('turns off CPU time without touching the wall profiler', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_CPU_ENABLED: 'false' })
    })

    it('leaves the enablement to local config when only some types are turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: false, heapSize: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
      })
    })

    it('disables profiling when every profile type is turned off', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { cpuTime: false, wallTime: false, heapSize: false, heapObjects: false } },
        }],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('needs heap objects turned off as well to disable profiling', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false, wallTime: false, heapSize: false } } }] })

      assert.strictEqual(currentSettings().DD_PROFILING_ENABLED, undefined)
    })

    it('ignores profile types this runtime does not collect', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { lock: true, exception: false } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })

    it('ignores settings, as none are mapped yet', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { settings: { stack_adaptive_sampling: true } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })

    it('reverts to local config for an empty profilers section', () => {
      update({ toApply: [{ id: 'a', file: { profilers: {} } }] })

      assert.strictEqual(currentSettings(), null)
    })
  })

  describe('validation', () => {
    it('ignores payloads without a profilers or settings section', () => {
      const transaction = update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.calledOnceWithExactly(transaction.ack, 'datadog/2/DEBUG/other-team/config')
    })

    it('ignores payloads that are not objects', () => {
      update({ toApply: [{ id: 'a', file: null }, { id: 'b', file: 'profilers' }] })

      assert.strictEqual(currentSettings(), null)
    })

    it('ignores fields of the wrong type and keeps the valid ones', () => {
      update({
        toApply: [{
          id: 'a',
          file: {
            profilers: { cpuTime: 'true', wallTime: 1, heapSize: true, unknown: true },
          },
        }],
      })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('ignores a config whose targets are not an array', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true }, targets: { service: 'my-service' } } }] })

      assert.strictEqual(currentSettings(), null)
    })

    it('ignores a config whose targets are all invalid instead of applying it everywhere', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { heapSize: true }, targets: [{ service: 1 }, { tags: 'team:profiling' }, 'x'] },
        }],
      })

      assert.strictEqual(currentSettings(), null)
    })

    it('skips invalid targets and keeps the valid ones', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { heapSize: true }, targets: [{ service: 1 }, { service: 'my-service' }] },
        }],
      })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })
  })

  describe('apply state', () => {
    const path = (id) => `datadog/2/DEBUG/${id}/config`

    it('acknowledges valid profiling payloads and payloads of other DEBUG users', () => {
      const transaction = update({
        toApply: [
          { id: 'a', file: { profilers: { heapSize: true }, settings: {} } },
          { id: 'other-team', file: { something: 'else' } },
          { id: 'not-an-object', file: 'text' },
        ],
      })

      sinon.assert.notCalled(transaction.error)
      sinon.assert.calledWithExactly(transaction.ack, path('a'))
      sinon.assert.calledWithExactly(transaction.ack, path('other-team'))
      sinon.assert.calledWithExactly(transaction.ack, path('not-an-object'))
    })

    it('reports a partially invalid profiling payload as an error and still applies its valid fields', () => {
      const transaction = update({
        toApply: [{
          id: 'a',
          file: {
            profilers: { cpuTime: 'true', heapSize: true },
            settings: 'fast',
            targets: [{ service: 'my-service' }, { env: 1 }],
          },
        }],
      })

      sinon.assert.notCalled(transaction.ack)
      sinon.assert.calledOnceWithExactly(
        transaction.error,
        path('a'),
        'targets[1] is invalid; profilers.cpuTime is not a boolean; settings is not an object'
      )
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('reports invalid sections as errors', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: [], settings: 'fast' } }] })

      sinon.assert.calledOnceWithExactly(
        transaction.error,
        path('a'),
        'profilers is not an object; settings is not an object'
      )
    })

    it('reports a config dropped for its targets as an error', () => {
      const transaction = update({
        toApply: [
          { id: 'not-array', file: { profilers: { heapSize: true }, targets: {} } },
          { id: 'all-invalid', file: { profilers: { heapSize: true }, targets: ['x'] } },
        ],
      })

      sinon.assert.calledWithExactly(transaction.error, path('not-array'), 'targets is not an array')
      sinon.assert.calledWithExactly(transaction.error, path('all-invalid'), 'targets[0] is invalid; no valid targets')
      assert.strictEqual(currentSettings(), null)
    })
  })

  describe('targets', () => {
    // A config with heapSize: false and the given targets, merged with an untargeted one with heapSize: true:
    // the result shows whether the targeted config ranked above the untargeted one.
    /**
     * @param {object[]} targets
     */
    function outranksUntargeted (targets) {
      update({
        toApply: [
          { id: 'a-targeted', file: { profilers: { heapSize: false }, targets } },
          { id: 'z-untargeted', file: { profilers: { heapSize: true } } },
        ],
      })
      return currentSettings().DD_PROFILING_HEAP_ENABLED === 'false'
    }

    it('applies every received config, whatever its targets', () => {
      for (const targets of [
        [{ service: 'other-service' }],
        [{ service: 'my-service', env: 'staging' }],
        [{ tags: ['kube_pod_name:not-known-to-the-tracer'] }],
      ]) {
        update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true }, targets } }] })
        assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
        update({ toUnapply: [{ id: 'a' }] })
      }
    })

    it('ranks a config by its targets consistent with the service and env', () => {
      assert.strictEqual(outranksUntargeted([{ service: 'my-service', env: 'prod' }]), true)
      assert.strictEqual(outranksUntargeted([{ env: 'prod' }]), true)
    })

    it('ranks a config without a consistent target lowest', () => {
      // Ties with the untargeted config are broken by id, which puts the untargeted one last.
      assert.strictEqual(outranksUntargeted([{ service: 'other-service' }, { env: 'staging' }]), false)
    })

    it('ignores inconsistent targets when ranking a config', () => {
      update({
        toApply: [
          // Its service+env target names another service, so it ranks as an env target.
          {
            id: 'a',
            file: {
              profilers: { heapSize: false },
              targets: [{ service: 'other-service', env: 'prod' }, { env: 'prod' }],
            },
          },
          { id: 'b', file: { profilers: { heapSize: true }, targets: [{ service: 'my-service' }] } },
        ],
      })

      assert.strictEqual(currentSettings().DD_PROFILING_HEAP_ENABLED, 'true')
    })

    // Merges a config with heapSize: false and the targets `higher` with one with heapSize: true and the
    // targets `lower`. The config with heapSize: true wins ties (by id), so heap is off only when `higher`
    // really ranks above `lower`.
    /**
     * @param {object[]} higher
     * @param {object[]} lower
     */
    function outranks (higher, lower) {
      update({ toUnapply: [{ id: 'a-higher' }, { id: 'z-lower' }] })
      update({
        toApply: [
          { id: 'a-higher', file: { profilers: { heapSize: false }, targets: higher } },
          { id: 'z-lower', file: { profilers: { heapSize: true }, targets: lower } },
        ],
      })
      return currentSettings().DD_PROFILING_HEAP_ENABLED === 'false'
    }

    it('ranks targets as other tags < env < service < workload < container name < pod < container ID', () => {
      const ordered = [
        [],
        [{ tags: ['kube_namespace:ns'] }],
        [{ env: 'prod' }],
        [{ service: 'my-service' }],
        [{ tags: ['kube_deployment:d'] }],
        [{ tags: ['kube_container_name:c'] }],
        [{ tags: ['pod_name:p'] }],
        [{ tags: ['container_id:abc'] }],
      ]
      for (let index = 1; index < ordered.length; index++) {
        assert.strictEqual(outranks(ordered[index], ordered[index - 1]), true, JSON.stringify(ordered[index]))
        assert.strictEqual(outranks(ordered[index - 1], ordered[index]), false, JSON.stringify(ordered[index]))
      }
    })

    it('recognizes every tag name of a level', () => {
      for (const name of ['kube_deployment', 'kube_replica_set', 'kube_stateful_set', 'kube_daemon_set', 'kube_job',
        'kube_cronjob', 'kube_argo_rollout', 'oshift_deployment', 'task_family']) {
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ service: 'my-service', env: 'prod' }]), true, name)
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['container_name:x'] }]), false, name)
      }
      for (const name of ['kube_container_name', 'container_name', 'ecs_container_name']) {
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['kube_deployment:x'] }]), true, name)
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['pod_name:x'] }]), false, name)
      }
      for (const name of ['pod_name', 'task_arn']) {
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['container_name:x'] }]), true, name)
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['container_id:x'] }]), false, name)
      }
    })

    it('lets a pod-specific config override a service-wide one, as in the payload merging ADR', () => {
      update({
        toApply: [
          {
            id: 'service',
            file: { profilers: { cpuTime: true, heapSize: false }, targets: [{ service: 'my-service' }] },
          },
          { id: 'pod', file: { profilers: { heapSize: true }, targets: [{ tags: ['pod_name:my-service-abcdef'] }] } },
        ],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('ranks a combined target by its most specific condition, then by its number of conditions', () => {
      assert.strictEqual(outranks([{ service: 'my-service', tags: ['pod_name:p'] }], [{ tags: ['kube_deployment:d'] }]),
        true)
      assert.strictEqual(outranks([{ service: 'my-service', tags: ['pod_name:p'] }], [{ tags: ['pod_name:p'] }]), true)
      assert.strictEqual(outranks([{ service: 'my-service', env: 'prod' }], [{ service: 'my-service' }]), true)
      assert.strictEqual(outranks([{ env: 'prod', tags: ['team:a', 'region:b'] }], [{ service: 'my-service' }]), false)
    })

    it('compares normalized service and env', () => {
      assert.strictEqual(outranks([{ service: 'My-Service', env: 'PROD' }], [{ env: 'prod' }]), true)
    })

    it('assumes the tag conditions of a target hold', () => {
      assert.strictEqual(outranksUntargeted([{ tags: ['kube_pod_name:not-known-to-the-tracer'] }]), true)
      update({ toUnapply: [{ id: 'a-targeted' }, { id: 'z-untargeted' }] })
      assert.strictEqual(outranksUntargeted([{ service: 'my-service', tags: ['team:other'] }]), true)
    })
  })

  describe('merging', () => {
    it('lets more specific configs win, field by field', () => {
      update({
        toApply: [
          {
            id: 'service-env',
            file: {
              profilers: { heapSize: false, heapObjects: false },
              targets: [{ service: 'my-service', env: 'prod' }],
            },
          },
          { id: 'service', file: { profilers: { wallTime: false }, targets: [{ service: 'my-service' }] } },
          { id: 'env', file: { profilers: { wallTime: true }, targets: [{ env: 'prod' }] } },
          { id: 'tags', file: { profilers: { cpuTime: false }, targets: [{ tags: ['team:profiling'] }] } },
          { id: 'org', file: { profilers: { cpuTime: true, heapSize: true } } },
        ],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('breaks ties between equally specific configs by id, independent of delivery order', () => {
      const first = { id: 'a', file: { profilers: { heapSize: true } } }
      const second = { id: 'b', file: { profilers: { heapSize: false } } }

      update({ toApply: [first, second] })
      const inOrder = currentSettings()
      update({ toUnapply: [first, second] })
      update({ toApply: [second, first] })

      assert.deepStrictEqual(currentSettings(), inOrder)
      assert.strictEqual(inOrder.DD_PROFILING_HEAP_ENABLED, 'false')
    })

    it('keeps configs across updates and drops them on unapply', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      update({ toApply: [{ id: 'b', file: { profilers: { wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })

      update({ toUnapply: [{ id: 'a' }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_WALLTIME_ENABLED: 'false' })

      update({ toUnapply: [{ id: 'b' }] })
      assert.strictEqual(currentSettings(), null)
    })

    it('replaces a config on modify, and drops it when it no longer carries profiling content', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: false } } }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'false' })

      update({ toModify: [{ id: 'a', file: { unrelated: true } }] })
      assert.strictEqual(currentSettings(), null)
    })

    it('acknowledges every item', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      const transaction = update({
        toApply: [{ id: 'b', file: { profilers: { heapSize: true } } }],
        toModify: [{ id: 'c', file: { nothing: 'here' } }],
        toUnapply: [{ id: 'a' }],
      })

      sinon.assert.calledThrice(transaction.ack)
      sinon.assert.notCalled(transaction.error)
    })
  })
})
