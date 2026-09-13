# klipper-ethercat

EtherCAT master for Klipper — drive CiA402 servo amplifiers straight from the
Klipper host, no step/dir MCU in between.

The Klipper host runs a SOEM-based EtherCAT master (through the
[pysoem](https://pypi.org/project/pysoem/) bindings) in a dedicated cyclic
thread: the bus cycles at 1 kHz, servo amplifiers are driven in CSP (cyclic
synchronous position) mode, and setpoints come from a built-in trapezoidal
planner. Status is exposed to Moonraker and shown in a Fluidd dashboard card.

```
Klipper (host) ── klippy/extras/ethercat.py ── SOEM ── raw NIC ── EtherCAT bus ── servo drives
```

## What works

- EtherCAT master on any NIC of the Klipper host, continuous bus scan until
  drives appear (the master tolerates an empty bus and keeps scanning)
- Automatic process-data layout discovery: CiA402 objects (0x6040/0x607A on
  RX, 0x6041/0x6064/0x606C on TX) are located inside the mapped PDOs via CoE
- Distributed clocks (SYNC0 at the bus cycle time) for drives that need them
- CiA402 power-up state machine (shutdown → switch on → operation enabled)
  driven automatically by `ETHERCAT_ENABLE`
- Built-in trapezoidal streaming planner per servo (`ETHERCAT_MOVE`)
- Live status in Moonraker (`get_status`) and a Fluidd dashboard card

## Install (Debian-style Klipper host, e.g. a mini PC)

```bash
# 1. pysoem into the klippy venv
~/klippy-env/bin/pip install pysoem

# 2. the klippy extra
cp klippy/extras/ethercat.py ~/klipper/klippy/extras/

# 3. klipper needs CAP_NET_RAW to open a raw EtherCAT socket
sudo mkdir -p /etc/systemd/system/klipper.service.d
printf '[Service]\nAmbientCapabilities=CAP_NET_RAW\n' \
  | sudo tee /etc/systemd/system/klipper.service.d/ethercat.conf
sudo systemctl daemon-reload

# 4. config (append to printer.cfg)
cat >> ~/printer_data/config/printer.cfg <<'EOF'
[ethercat]
interface: enp3s0      # dedicated NIC for the EtherCAT bus
cycle_time: 0.001

#[ethercat_servo axis0]
#slave: 0              # bus position of the drive
#scale: 1.0            # user units per drive position count
#velocity: 100.0
#acceleration: 1000.0
EOF

# 5. Fluidd card + full control page (patches fluidd's index.html)
sudo bash embed/install-ecat-panel.sh
sudo systemctl restart klipper
```

`install-ecat-panel.sh` injects two scripts into Fluidd:

- a dashboard card (below the temperature panel) with live master/servo status
- a **full EtherCAT control page**: an "EtherCAT" entry is added to the Fluidd
  navigation (below Settings) — open it for the master status, per-servo
  enable/disable, target position / velocity / acceleration inputs with MOVE
  and HOLD buttons. Commands run through the Moonraker websocket and require
  klippy to be in the ready state.

## G-code

| Command | Purpose |
|---|---|
| `ETHERCAT_STATUS` | Master state, bus scan results, per-servo status |
| `ETHERCAT_ENABLE [NAME=<n>]` | Bring bus to OP + run the CiA402 power-up sequence |
| `ETHERCAT_DISABLE [NAME=<n>]` | Shutdown (servos go to ready-to-switch-on) |
| `ETHERCAT_MOVE NAME=<n> POS=<u> [VEL=] [ACCEL=]` | Trapezoidal move in user units |

## Hardware notes

- **Use a dedicated NIC for the EtherCAT bus.** EtherCAT frames are raw
  ethernet; the same port must not carry your LAN/SSH traffic. Any cheap
  USB/PCIe ethernet adapter works — SOEM opens it directly.
- Most servo drives (Leadshine, DMM, Rtelligent, Yaskawa IPC, ...) ship with
  a default PDO mapping that already contains 0x6040/0x607A/0x6041/0x6064,
  which is all this module needs. Drives that require SDO-based PDO
  reconfiguration need that written once via their vendor tool.
- CSP mode without drive-side trajectory buffering assumes the host keeps the
  1 kHz cadence; on an otherwise idle host (J1900 tested) worst-case jitter
  observed is in the hundreds of microseconds.

## Status / honest limitations

- Tested end-to-end on the master side (bus scan, moonraker reporting, Fluidd
  card) on Debian 12 with pysoem 1.1.9 and no drives attached — the servo
  CSP path is implemented per CiA402 but has not yet run against real
  hardware; expect drive-specific tuning (DC setup, opmode switching).
- This is an independent-axis / gantry-follower style integration. Full
  klipper kinematics integration would need virtual-stepper support in the
  klipper core (same limitation as the CAN ODrive module).
