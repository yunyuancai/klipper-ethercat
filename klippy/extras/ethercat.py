# EtherCAT master support for Klipper — direct servo drive control without MCU.
#
# Runs a SOEM-based EtherCAT master (via the pysoem bindings) in a dedicated
# cyclic thread on the host, drives CiA402 servo drives in CSP (cyclic
# synchronous position) mode, and streams setpoints from a built-in
# trapezoidal planner at the configured cycle time (default 1 kHz).
#
# Config:
#   [ethercat]
#   interface: enp3s0        # dedicated NIC for the EtherCAT bus
#   cycle_time: 0.001        # bus cycle [s]
#
#   [ethercat_servo <name>]
#   slave: 0                 # bus position (0 = first drive after master)
#   scale: 1.0               # user units per drive position count
#   velocity: 100.0          # default user units/s
#   acceleration: 1000.0     # default user units/s^2
#
# G-code: ETHERCAT_STATUS, ETHERCAT_ENABLE [NAME=], ETHERCAT_DISABLE [NAME=],
#         ETHERCAT_MOVE NAME=<name> POS=<user units> [VEL=] [ACCEL=]
#
# Requires: pysoem in the klippy virtualenv.
#
# Distributed under the GNU GPLv3 license.
import logging
import math
import struct
import threading
import time


def cia402_state(status_word):
    sw = status_word & 0x6F
    if sw == 0x00: return 'not-ready-to-switch-on'
    if sw in (0x40, 0x50, 0x2F): return 'switch-on-disabled'
    if sw == 0x31: return 'ready-to-switch-on'
    if sw == 0x33: return 'switched-on'
    if sw == 0x37: return 'operation-enabled'
    if sw == 0x07: return 'quick-stop-active'
    if sw == 0x0F: return 'fault-reaction'
    if sw == 0x0B: return 'fault'
    return 'unknown-0x%02x' % (status_word & 0xFF,)


class EtherCATServo:
    def __init__(self, config, master):
        self.master = master
        self.name = config.get_name().split()[-1]
        self.slave_index = config.getint('slave', 0, minval=0)
        self.scale = config.getfloat('scale', 1.0, above=0.)
        self.def_velocity = config.getfloat('velocity', 100., above=0.)
        self.def_accel = config.getfloat('acceleration', 1000., above=0.)
        # PDO bit offsets (discovered via CoE)
        self.off_cw = None      # 0x6040 controlword   (RX)
        self.off_tp = None      # 0x607A target pos    (RX)
        self.off_sw = None      # 0x6041 statusword    (TX)
        self.off_ap = None      # 0x6064 actual pos    (TX)
        self.off_vc = None      # 0x606C actual vel    (TX, optional)
        # runtime
        self.control_word = 0
        self.enable_pending = False
        self.enabled = False
        self.enabling_step = 0
        self.last_step_ts = 0.
        self.target = 0.          # user units
        self.cmd_pos = 0          # drive counts (commanded)
        self.act_pos = 0          # drive counts (actual)
        self.act_vel = 0          # drive counts/s (actual)
        self.status_word = 0
        self.error = False

    def discover_pdo_layout(self, slave):
        rx = self._map_side(slave, 0x1C12)
        tx = self._map_side(slave, 0x1C13)
        if rx is None or tx is None:
            return False
        for bit, obj, bits in rx:
            if obj == 0x6040: self.off_cw = bit
            if obj == 0x607A: self.off_tp = bit
        for bit, obj, bits in tx:
            if obj == 0x6041: self.off_sw = bit
            if obj == 0x6064: self.off_ap = bit
            if obj == 0x606C: self.off_vc = bit
        return None not in (self.off_cw, self.off_tp, self.off_sw, self.off_ap)

    def _map_side(self, slave, assign_idx):
        out = []
        try:
            bit = 0
            n = slave.sdo_read(assign_idx, 0, 1)[0]
            for e in range(1, n + 1):
                pdo_idx = int.from_bytes(slave.sdo_read(assign_idx, e, 2), 'little')
                cnt = slave.sdo_read(pdo_idx, 0, 1)[0]
                for m in range(1, cnt + 1):
                    val = int.from_bytes(slave.sdo_read(pdo_idx, m, 4), 'little')
                    obj = (val >> 16) & 0xFFFF
                    bits = val & 0xFF
                    out.append((bit, obj, bits))
                    bit += bits
            return out
        except Exception as e:
            logging.info("ethercat: PDO discovery failed (0x%04X): %s"
                         % (assign_idx, e))
            return None

    def fill_output(self, sl):
        out = bytearray(sl.output)
        if self.off_cw is not None:
            struct.pack_into('<H', out, self.off_cw // 8, self.control_word)
        if self.off_tp is not None:
            struct.pack_into('<i', out, self.off_tp // 8, self.cmd_pos)
        sl.output = bytes(out)

    def read_input(self, sl):
        inp = sl.input
        if self.off_sw is not None:
            self.status_word = struct.unpack_from('<H', inp, self.off_sw // 8)[0]
        if self.off_ap is not None:
            self.act_pos = struct.unpack_from('<i', inp, self.off_ap // 8)[0]
        if self.off_vc is not None:
            self.act_vel = struct.unpack_from('<i', inp, self.off_vc // 8)[0]
        self.error = bool(self.status_word & 0x8)

    def planner_step(self, dt):
        """Trapezoidal step of cmd_pos [counts] toward target [user units]."""
        if self.off_tp is None:
            return
        d_u = self.target - self.cmd_pos * self.scale
        if abs(d_u) < 1e-9:
            return
        v_c = max(self.def_velocity / self.scale, 1e-6)     # counts/s
        a_c = max(self.def_accel / self.scale, 1e-6)        # counts/s^2
        d_c = self.target / self.scale - self.cmd_pos
        sign = 1. if d_c > 0 else -1.
        v_lim = math.sqrt(max(2. * a_c * abs(d_c), 0.))
        v = min(v_c, v_lim)
        new = self.cmd_pos + sign * v * dt
        if (d_c > 0 and new > self.target / self.scale) or \
           (d_c < 0 and new < self.target / self.scale):
            new = int(round(self.target / self.scale))
        self.cmd_pos = int(new)


class EtherCATMaster:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.gcode = self.printer.lookup_object('gcode')
        self.ifname = config.get('interface', 'enp3s0')
        self.cycle_time = config.getfloat('cycle_time', 0.001,
                                          minval=0.0002, maxval=0.01)
        self.servos = [EtherCATServo(scfg, self)
                       for scfg in config.get_prefix_sections('ethercat_servo ')]

        self.state = 'uninitialized'
        self.slave_count = 0
        self.slave_names = []
        self.cycles = 0
        self.jitter_max = 0.
        self.pysoem = None
        self._mctx = None
        self._thread = None
        self._stop = False
        self._lock = threading.Lock()

        for s in self.servos:
            logging.info("ethercat: configured servo '%s' slave=%d"
                         % (s.name, s.slave_index))

        self.printer.register_event_handler('klippy:ready', self._handle_ready)
        # start immediately: klippy may sit in an error state (e.g. missing mcu)
        # and never fire klippy:ready, but the bus should still come up
        self._handle_ready()
        self.printer.register_event_handler('klippy:disconnect',
                                            self._handle_disconnect)
        self.gcode.register_command('ETHERCAT_STATUS', self.cmd_STATUS,
                                    desc="Report EtherCAT master/servo status")
        self.gcode.register_command('ETHERCAT_ENABLE', self.cmd_ENABLE,
                                    desc="Start CiA402 power-up sequence: "
                                         "ETHERCAT_ENABLE [NAME=<n>]")
        self.gcode.register_command('ETHERCAT_DISABLE', self.cmd_DISABLE,
                                    desc="Disable servos: ETHERCAT_DISABLE [NAME=<n>]")
        self.gcode.register_command('ETHERCAT_MOVE', self.cmd_MOVE,
                                    desc="ETHERCAT_MOVE NAME=<n> POS=<u> [VEL=] [ACCEL=]")

    # -- lifecycle ---------------------------------------------------------

    def _handle_ready(self):
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _handle_disconnect(self):
        self._stop = True
        self._close_ctx()
        self.state = 'stopped'

    def _run(self):
        while not self._stop:
            try:
                if self.pysoem is None:
                    import pysoem
                    self.pysoem = pysoem
                self._bus_loop()
            except Exception as e:
                logging.exception("ethercat: bus error, retrying")
                self.state = 'error: %s' % (str(e) or type(e).__name__,)
                with self._lock:
                    self.slave_count = 0
                    self.slave_names = []
                self._close_ctx()
                for _ in range(50):     # sleep 5s in small steps
                    if self._stop:
                        return
                    time.sleep(0.1)

    def _close_ctx(self):
        try:
            if self._mctx is not None:
                self._mctx.close()
        except Exception:
            pass
        self._mctx = None

    # -- bus ---------------------------------------------------------------

    def _bus_loop(self):
        pysoem = self.pysoem
        m = pysoem.Master()
        m.open(self.ifname)
        self._mctx = m
        n = m.config_init()
        self.state = 'init'
        if n <= 0:
            self.state = 'scanning (no slaves)'
            self._close_ctx()
            for _ in range(50):
                if self._stop:
                    return
                time.sleep(0.1)
            return
        names = [sl.name for sl in m.slaves]
        with self._lock:
            self.slave_names = names
            self.slave_count = n
        logging.info("ethercat: %d slave(s) found: %s" % (n, ', '.join(names)))
        self.state = 'configuring'

        for s in self.servos:
            if s.slave_index >= n:
                logging.warning("ethercat: servo '%s' slave index %d out of range"
                                % (s.name, s.slave_index))
                continue
            if not s.discover_pdo_layout(m.slaves[s.slave_index]):
                logging.warning(
                    "ethercat: servo '%s': CiA402 PDO objects (0x6040/0x607A/"
                    "0x6041/0x6064) not all present in the mapped PDOs" % (s.name,))

        try:
            for i, sl in enumerate(m.slaves):
                if sl.dc_active:
                    sl.dc_sync(True, int(self.cycle_time * 1e9))
            m.config_dc()
            logging.info("ethercat: DC configured")
        except Exception as e:
            logging.warning("ethercat: DC setup skipped (%s)" % (e,))

        m.config_map()
        st = m.state_check(pysoem.SAFEOP_STATE, 2_000_000)
        if st < pysoem.SAFEOP_STATE:
            logging.warning("ethercat: reached only %s"
                            % (STATE_NAMES.get(st, st),))
        m.write_state()
        st = m.state_check(pysoem.OP_STATE, 3_000_000)
        if st >= pysoem.OP_STATE:
            self.state = 'op'
            logging.info("ethercat: bus in OP, cyclic loop at %.3f ms"
                         % (self.cycle_time * 1000.))
            self._cyclic(m)
        else:
            self.state = 'failed: %s' % (STATE_NAMES.get(st, st),)
            self._close_ctx()
            for _ in range(50):
                if self._stop:
                    return
                time.sleep(0.1)

    def _cyclic(self, m):
        period = self.cycle_time
        next_t = time.perf_counter()
        err_streak = 0
        while not self._stop:
            loop_start = time.perf_counter()
            with self._lock:
                servos = list(self.servos)
                cnt = self.slave_count
            for s in servos:
                if s.slave_index < cnt:
                    s.planner_step(period)
            try:
                for s in servos:
                    if s.slave_index < cnt:
                        s.fill_output(m.slaves[s.slave_index])
                m.send_processdata()
                m.receive_processdata(2000)
                for s in servos:
                    if s.slave_index < cnt:
                        s.read_input(m.slaves[s.slave_index])
                err_streak = 0
                self.cycles += 1
            except Exception as e:
                err_streak += 1
                if err_streak <= 3:
                    logging.exception("ethercat: cyclic error")
                if err_streak > 500:
                    raise
            self._enable_sequencer(servos, cnt, m)
            next_t += period
            delay = next_t - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
                self.jitter_max = max(self.jitter_max, 0.)
            else:
                self.jitter_max = max(self.jitter_max, -delay * 1000.)
                next_t = time.perf_counter()

    def _enable_sequencer(self, servos, cnt, m):
        now = time.monotonic()
        for s in servos:
            if s.slave_index >= cnt or s.off_sw is None:
                continue
            if not s.enable_pending or s.enabled:
                continue
            st = cia402_state(s.status_word)
            if st == 'operation-enabled':
                s.enabled = True
                s.enable_pending = False
                s.cmd_pos = s.act_pos
                s.target = s.act_pos * s.scale
                logging.info("ethercat: servo '%s' operation-enabled (pos synced)"
                             % (s.name,))
                continue
            if st == 'fault' or st == 'fault-reaction':
                s.enable_pending = False
                logging.warning("ethercat: servo '%s' in fault" % (s.name,))
                continue
            if st == 'switch-on-disabled':
                s.control_word = 0x06          # shutdown
            elif st == 'ready-to-switch-on':
                s.control_word = 0x07          # switch on
            elif st == 'switched-on':
                s.control_word = 0x0F          # enable operation
            if now - s.last_step_ts >= 0.1:
                s.last_step_ts = now
                logging.info("ethercat: servo '%s' enabling: %s -> CW=0x%02X"
                             % (s.name, st, s.control_word))

    # -- gcode -------------------------------------------------------------

    def _get_servo(self, name):
        for s in self.servos:
            if s.name == name:
                return s
        raise self.gcode.error("unknown ethercat servo '%s'" % (name,))

    def cmd_STATUS(self, gcmd):
        with self._lock:
            names = list(self.slave_names)
            cnt = self.slave_count
        out = ["EtherCAT: state=%s interface=%s cycle=%.2fms cycles=%d "
               "jitter_max=%.2fms slaves=%d"
               % (self.state, self.ifname, self.cycle_time * 1000.,
                  self.cycles, self.jitter_max, cnt)]
        if names:
            out.append("slaves: %s" % ', '.join(names))
        for s in self.servos:
            out.append("servo '%s': enabled=%s state=%s pos=%d target=%s err=%s"
                       % (s.name, s.enabled, cia402_state(s.status_word),
                          s.act_pos, s.target, s.error))
        gcmd.respond_info('\n'.join(out))

    def cmd_ENABLE(self, gcmd):
        if self.state != 'op':
            raise gcode.error("EtherCAT bus not in OP (state=%s)" % (self.state,))
        name = gcmd.get('NAME', None)
        servos = [self._get_servo(name)] if name else self.servos
        for s in servos:
            s.enable_pending = True
            s.enabled = False
            s.enabling_step = 0
            s.last_step_ts = 0.
        gcmd.respond_info("EtherCAT: power-up sequence started for %s"
                          % (name or 'all servos',))

    def cmd_DISABLE(self, gcmd):
        name = gcmd.get('NAME', None)
        servos = [self._get_servo(name)] if name else self.servos
        for s in servos:
            s.enable_pending = False
            s.enabled = False
            s.control_word = 0x06     # shutdown -> ready-to-switch-on
        gcmd.respond_info("EtherCAT: disabled %s" % (name or 'all servos',))

    def cmd_MOVE(self, gcmd):
        s = self._get_servo(gcmd.get('NAME'))
        if not s.enabled:
            raise gcode.error("servo '%s' not enabled; run ETHERCAT_ENABLE first"
                              % (s.name,))
        s.target = gcmd.get_float('POS')
        if gcmd.get('VEL', None) is not None:
            s.def_velocity = gcmd.get_float('VEL', minval=0.)
        if gcmd.get('ACCEL', None) is not None:
            s.def_accel = gcmd.get_float('ACCEL', minval=0.)
        gcmd.respond_info("EtherCAT: '%s' -> %s (vel=%s acc=%s)"
                          % (s.name, s.target, s.def_velocity, s.def_accel))

    # -- moonraker ----------------------------------------------------------

    def get_status(self, eventtime):
        servos = {}
        for s in self.servos:
            servos[s.name] = {
                'enabled': s.enabled,
                'drive_state': cia402_state(s.status_word),
                'position': s.act_pos,
                'velocity': s.act_vel,
                'target': s.target,
                'error': s.error,
                'status_word': s.status_word,
            }
        with self._lock:
            names = list(self.slave_names)
            cnt = self.slave_count
        return {
            'state': self.state,
            'interface': self.ifname,
            'cycle_time': self.cycle_time,
            'cycles': self.cycles,
            'jitter_max_ms': self.jitter_max,
            'slave_count': cnt,
            'slaves': names,
            'servos': servos,
        }


STATE_NAMES = {0: 'none', 1: 'init', 2: 'pre-op', 3: 'safe-op', 4: 'op', 8: 'error'}


def load_config(config):
    return EtherCATMaster(config)
