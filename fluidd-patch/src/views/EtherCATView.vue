<template>
  <v-row :dense="$vuetify.breakpoint.smAndDown">
    <v-col
      cols="12"
      md="6"
    >
      <collapsable-card
        title="EtherCAT Master"
        icon="$power"
        :collapsable="true"
        class="mb-2 mb-md-4"
      >
        <template #menu>
          <app-btn
            small
            :color="busState === 'op' ? 'primary' : undefined"
            :disabled="!klippyReady"
            @click="send('ETHERCAT_ENABLE')"
          >
            ENABLE ALL
          </app-btn>
          <app-btn
            small
            class="ml-2"
            :disabled="!klippyReady"
            @click="send('ETHERCAT_DISABLE')"
          >
            DISABLE ALL
          </app-btn>
        </template>

        <div class="py-1">
          <v-row
            v-for="r in masterRows"
            :key="r.label"
            no-gutters
            class="py-1"
          >
            <v-col>{{ r.label }}</v-col>
            <v-col class="text-right font-weight-medium">{{ r.value }}</v-col>
          </v-row>
        </div>
      </collapsable-card>

      <collapsable-card
        v-for="(servo, name) in servos"
        :key="name"
        :title="'Servo: ' + name"
        icon="$power"
        :collapsable="true"
        class="mb-2 mb-md-4"
      >
        <template #menu>
          <span
            class="mr-2"
            :style="{ color: servo.error ? '#ff5252' : '#4caf50' }"
          >{{ servo.drive_state }}</span>
        </template>

        <div class="py-1">
          <v-row no-gutters>
            <v-col cols="6">
              <app-text-field
                :value="inputTarget(name)"
                :label="'Target [' + posUnit(name) + ']'"
               
                @input="setInputTarget(name, $event)"
              />
            </v-col>
            <v-col
              cols="6"
              class="pl-2"
            >
              <app-text-field
                :value="inputVel(name)"
                :label="'Velocity [u/s]'"
                @input="setInputVel(name, $event)"
              />
            </v-col>
          </v-row>
          <v-row no-gutters>
            <v-col cols="6">
              <app-text-field
                :value="inputAcc(name)"
                :label="'Acceleration [u/s²]'"
                @input="setInputAcc(name, $event)"
              />
            </v-col>
            <v-col class="d-flex align-center justify-end">
              <app-btn
                :disabled="!klippyReady"
                small
                class="ma-1"
                @click="moveServo(name)"
              >
                MOVE
              </app-btn>
              <app-btn
                :disabled="!klippyReady"
                small
                class="ma-1"
                @click="holdServo(name)"
              >
                HOLD
              </app-btn>
            </v-col>
          </v-row>

          <v-row no-gutters>
            <v-col>Enabled</v-col>
            <v-col class="text-right font-weight-medium">
              {{ servo.enabled ? 'yes' : 'no' }}
            </v-col>
          </v-row>
          <v-row no-gutters>
            <v-col>Position / Target</v-col>
            <v-col class="text-right font-weight-medium">
              {{ servo.position }} / {{ servo.target }}
            </v-col>
          </v-row>
          <v-row no-gutters>
            <v-col>Status word</v-col>
            <v-col
              class="text-right font-weight-medium"
              :style="{ color: servo.error ? '#ff5252' : '' }"
            >
              0x{{ (servo.status_word >>> 0).toString(16) }}
            </v-col>
          </v-row>
        </div>
      </collapsable-card>

      <collapsable-card
        v-if="!servoCount"
        title="No servo drives configured"
        icon="$power"
        :collapsable="false"
        class="mb-2 mb-md-4"
      >
        <div class="py-1">
          Add an <code>[ethercat_servo &lt;name&gt;]</code> section to printer.cfg,
          set <code>slave</code> to the drive's bus position, then restart Klipper.
          The drive appears here once it is found on the bus and the bus is in OP.
        </div>
      </collapsable-card>
    </v-col>

    <v-col
      cols="12"
      md="6"
    >
      <collapsable-card
        title="Usage"
        icon="$help"
        :collapsable="false"
        class="mb-2 mb-md-4"
      >
        <div class="py-1">
          <ol class="pl-4">
            <li class="py-1">
              Wire the drive to a <b>dedicated</b> NIC of this host (the one set
              as <code>interface</code> in <code>[ethercat]</code>).
            </li>
            <li class="py-1">
              Restart Klipper — the master scans the bus until the drive answers.
            </li>
            <li class="py-1">
              Run <code>ETHERCAT_ENABLE</code> (or the button above) to power the
              drive up (CiA402: shutdown → switch on → operation enabled).
            </li>
            <li class="py-1">
              Move with <code>ETHERCAT_MOVE NAME=&lt;n&gt; POS=&lt;target&gt;</code>
              or the controls above. Units are set by <code>scale</code>.
            </li>
          </ol>
        </div>
      </collapsable-card>

      <collapsable-card
        title="SDO Commissioning"
        icon="$codeJson"
        :collapsable="true"
        class="mb-2 mb-md-4"
      >
        <template #menu>
          <span
            class="caption mr-2"
            :style="{ color: lastSdoOk === false ? '#ff5252' : '#4caf50' }"
          >{{ lastSdoText }}</span>
        </template>

        <div class="py-1">
          <div class="ecat-note pb-2">
            Read/write any CoE object on a bus slave — commission drives without
            printer.cfg sections. Index accepts hex (0x6041). Values: decimal or
            0x-hex. CiA402 INIT runs the slow SDO power-up sequence (opmode
            0x6060 → CW 6/7/0x0F).
          </div>
          <v-row no-gutters>
            <v-col
              cols="3"
              class="pr-1"
            >
              <app-text-field
                v-model="sdoSlave"
                label="Slave"
                small
              />
            </v-col>
            <v-col
              cols="3"
              class="px-1"
            >
              <app-text-field
                v-model="sdoIndex"
                label="Index (hex)"
                small
              />
            </v-col>
            <v-col
              cols="3"
              class="px-1"
            >
              <app-text-field
                v-model="sdoSub"
                label="Sub"
                small
              />
            </v-col>
            <v-col
              cols="3"
              class="pl-1"
            >
              <app-text-field
                v-model="sdoSize"
                label="Size"
                small
              />
            </v-col>
          </v-row>
          <v-row no-gutters>
            <v-col
              cols="6"
              class="pr-1"
            >
              <app-text-field
                v-model="sdoValue"
                label="Value (write)"
                small
              />
            </v-col>
            <v-col
              class="d-flex align-center justify-end"
            >
              <app-btn
                small
                class="ma-1"
                :disabled="!klippyReady"
                @click="sdoRead()"
              >
                READ
              </app-btn>
              <app-btn
                small
                class="ma-1"
                :disabled="!klippyReady"
                @click="sdoWrite()"
              >
                WRITE
              </app-btn>
              <app-btn
                small
                class="ma-1"
                :disabled="!klippyReady"
                @click="sdoCia402()"
              >
                CiA402 INIT
              </app-btn>
            </v-col>
          </v-row>
        </div>
      </collapsable-card>
    </v-col>
  </v-row>
</template>

<script lang="ts">
import { Component, Mixins } from 'vue-property-decorator'
import StateMixin from '@/mixins/state'
import CollapsableCard from '@/components/common/CollapsableCard.vue'
import { SocketActions } from '@/api/socketActions'
import AppTextField from '@/components/ui/AppTextField.vue'

/* eslint-disable @typescript-eslint/no-explicit-any */

@Component({
  components: {
    CollapsableCard,
    AppTextField
  }
})
export default class EtherCATView extends Mixins(StateMixin) {
  inputTargets: Record<string, string> = {}
  inputVels: Record<string, string> = {}
  inputAccs: Record<string, string> = {}
  sdoSlave = '0'
  sdoIndex = '0x6041'
  sdoSub = '0'
  sdoSize = '2'
  sdoValue = '0'

  get ethercat (): any {
    const st = (this.$typedState as any).printer.printer.ethercat
    return st || {}
  }

  get lastSdo (): any {
    return this.ethercat.last_sdo || {}
  }

  get lastSdoOk (): boolean | null {
    const l = this.lastSdo
    if (l.ts == null) return null
    return !!l.ok
  }

  get lastSdoText (): string {
    const l = this.lastSdo
    if (l.ts == null) return ''
    if (l.ok) {
      if (l.type === 'read') {
        return '0x' + Number(l.index).toString(16) + ':' + l.sub + ' = 0x' + (l.hex || '')
      }
      return 'write ok'
    }
    return 'error: ' + (l.error || '')
  }

  sdoRead () {
    this.send('ETHERCAT_SDO_READ SLAVE=' + this.sdoSlave +
              ' INDEX=' + this.sdoIndex + ' SUB=' + this.sdoSub +
              ' SIZE=' + this.sdoSize)
  }

  sdoWrite () {
    this.send('ETHERCAT_SDO_WRITE SLAVE=' + this.sdoSlave +
              ' INDEX=' + this.sdoIndex + ' SUB=' + this.sdoSub +
              ' VALUE=' + this.sdoValue + ' SIZE=' + this.sdoSize)
  }

  sdoCia402 () {
    this.send('ETHERCAT_CIA402_INIT SLAVE=' + this.sdoSlave +
              ' OPMODE=8')
  }

  get klippyReady (): boolean {
    return this.$typedGetters['printer/getKlippyReady']
  }

  get busState (): string {
    return this.ethercat.state || 'unknown'
  }

  get servoCount (): number {
    return Object.keys(this.servos).length
  }

  get servos (): Record<string, any> {
    return this.ethercat.servos || {}
  }

  get masterRows (): { label: string, value: string }[] {
    return [
      { label: 'State', value: String(this.ethercat.state || '--') },
      { label: 'Interface', value: String(this.ethercat.interface || '--') },
      { label: 'Cycle', value: this.ethercat.cycle_time ? (this.ethercat.cycle_time * 1000).toFixed(2) + ' ms' : '--' },
      { label: 'Cycles', value: String(this.ethercat.cycles ?? '--') },
      { label: 'Jitter max', value: this.ethercat.jitter_max_ms != null ? this.ethercat.jitter_max_ms.toFixed(2) + ' ms' : '--' },
      { label: 'Slaves', value: (this.ethercat.slaves || []).join(', ') || '(none)' }
    ]
  }

  posUnit (name: string): string {
    return 'u'
  }

  inputTarget (name: string): string {
    return this.inputTargets[name] ?? String(this.servos[name]?.target ?? 0)
  }

  inputVel (name: string): string {
    return this.inputVels[name] ?? ''
  }

  inputAcc (name: string): string {
    return this.inputAccs[name] ?? ''
  }

  setInputTarget (name: string, v: string) {
    this.inputTargets = { ...this.inputTargets, [name]: v }
  }

  setInputVel (name: string, v: string) {
    this.inputVels = { ...this.inputVels, [name]: v }
  }

  setInputAcc (name: string, v: string) {
    this.inputAccs = { ...this.inputAccs, [name]: v }
  }

  send (script: string) {
    SocketActions.printerGcodeScript(script)
  }

  moveServo (name: string) {
    let cmd = 'ETHERCAT_MOVE NAME=' + name + ' POS=' + this.inputTarget(name)
    const vel = this.inputVel(name)
    const acc = this.inputAcc(name)
    if (vel) cmd += ' VEL=' + vel
    if (acc) cmd += ' ACCEL=' + acc
    this.send(cmd)
  }

  holdServo (name: string) {
    this.send('ETHERCAT_MOVE NAME=' + name + ' POS=' + (this.servos[name]?.position ?? 0))
  }
}
</script>
