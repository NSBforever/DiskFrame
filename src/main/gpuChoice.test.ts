import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gpuSwitchFor, parseVideoControllers, readGpuSwitch, writeGpuSwitch } from './gpuChoice.ts'

const NV = { vendorId: 0x10de, deviceId: 0x25a2 }
const AMD = { vendorId: 0x1002, deviceId: 0x1638 }
const INTEL = { vendorId: 0x8086, deviceId: 0x9a49 }

test('a laptop panel on the integrated GPU renders on the integrated GPU', () => {
  assert.equal(gpuSwitchFor([{ ...NV, hasDisplay: false }, { ...AMD, hasDisplay: true }]), 'force_low_power_gpu')
  assert.equal(gpuSwitchFor([{ ...INTEL, hasDisplay: true }, { ...NV, hasDisplay: false }]), 'force_low_power_gpu')
  assert.equal(gpuSwitchFor([{ ...INTEL, hasDisplay: true }, { ...AMD, hasDisplay: false }]), 'force_low_power_gpu')
})

test('a monitor on the graphics card renders on the graphics card', () => {
  assert.equal(gpuSwitchFor([{ ...NV, hasDisplay: true }, { ...INTEL, hasDisplay: false }]), 'force_high_performance_gpu')
  assert.equal(gpuSwitchFor([{ ...AMD, hasDisplay: true }, { ...INTEL, hasDisplay: false }]), 'force_high_performance_gpu')
})

test('nothing is forced when there is no single right answer', () => {
  assert.equal(gpuSwitchFor([{ ...NV, hasDisplay: true }]), null) // one GPU
  assert.equal(gpuSwitchFor([]), null)
  // Screens on both adapters, or on neither (a remote session).
  assert.equal(gpuSwitchFor([{ ...NV, hasDisplay: true }, { ...AMD, hasDisplay: true }]), null)
  assert.equal(gpuSwitchFor([{ ...NV, hasDisplay: false }, { ...AMD, hasDisplay: false }]), null)
  // Two GPUs of one vendor cannot be told apart by vendor.
  assert.equal(gpuSwitchFor([{ ...AMD, hasDisplay: true }, { ...AMD, deviceId: 0x73df, hasDisplay: false }]), null)
  assert.equal(gpuSwitchFor([{ ...NV, hasDisplay: true }, { ...AMD, hasDisplay: false }, { ...INTEL, hasDisplay: false }]), null)
})

test('Win32_VideoController output becomes adapters', () => {
  // What this machine prints: the panel is on the Radeon, nothing on the GeForce.
  const two = JSON.stringify([
    { PNPDeviceID: 'PCI\\VEN_10DE&DEV_25A2&SUBSYS_3A5C17AA&REV_A1\\4&2F1A', CurrentHorizontalResolution: null },
    { PNPDeviceID: 'PCI\\VEN_1002&DEV_1638&SUBSYS_3A5C17AA&REV_C5\\4&1C2B', CurrentHorizontalResolution: 2880 }
  ])
  assert.deepEqual(parseVideoControllers(two), [
    { ...NV, hasDisplay: false },
    { ...AMD, hasDisplay: true }
  ])
  assert.equal(gpuSwitchFor(parseVideoControllers(two)), 'force_low_power_gpu')
  // One controller is printed as an object, not an array.
  assert.deepEqual(parseVideoControllers('{"PNPDeviceID":"PCI\\\\VEN_8086&DEV_9A49","CurrentHorizontalResolution":1920}'), [{ ...INTEL, hasDisplay: true }])
  // A virtual display driver is not a GPU; junk is nothing.
  assert.deepEqual(parseVideoControllers('{"PNPDeviceID":"ROOT\\\\DISPLAY\\\\0000","CurrentHorizontalResolution":1920}'), [])
  assert.deepEqual(parseVideoControllers('not json'), [])
  assert.deepEqual(parseVideoControllers(''), [])
})

test('the stored answer round-trips, and DF_GPU overrides it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'df-gpu-')), 'gpu.json')
  assert.equal(readGpuSwitch(file, undefined), null) // first run
  writeGpuSwitch(file, 'force_low_power_gpu')
  assert.equal(readGpuSwitch(file, undefined), 'force_low_power_gpu')
  assert.equal(readGpuSwitch(file, 'default'), null)
  assert.equal(readGpuSwitch(file, 'high'), 'force_high_performance_gpu')
  writeGpuSwitch(file, null)
  assert.equal(readGpuSwitch(file, undefined), null)
  assert.equal(readGpuSwitch(file, 'low'), 'force_low_power_gpu')
  // Only the two known switches are ever passed to Chromium.
  writeFileSync(file, '{"switch":"no-sandbox"}')
  assert.equal(readGpuSwitch(file, undefined), null)
  writeFileSync(file, 'garbage')
  assert.equal(readGpuSwitch(file, undefined), null)
})
