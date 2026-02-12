'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class LGAWHPDevice extends Homey.Device {

  async onInit() {
    this.log('LG AWHP Device has been initialized');

    // Track if device is being deleted to prevent operations on deleted device
    this._isDeleted = false;

    // Get device settings
    this.settings = this.getSettings();

    // Initialize Modbus client
    this.modbus = new ModbusClient();

    // Apply connection timeout setting to ModbusClient
    if (this.settings.connection_timeout) {
      this.modbus.connectionTimeout = this.settings.connection_timeout;
    }

    // Previous values for event detection
    this.previousValues = {};

    // Error tracking for graceful degradation
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = this.settings.max_consecutive_errors || 3;

    // Setup Modbus event handlers
    this.setupModbusHandlers();

    // Fix missing capabilities
    await this.repairCapabilities();

    // Start polling
    this.startPolling();

    // Register capability listeners for writable capabilities
    this.setupCapabilityListeners();

    // Register flow trigger cards
    this.registerFlowCardTriggers();

    // Energy accumulation tracking
    this._lastPollTime = null;
    // One-time reset: clear bogus thermal energy accumulated before unitId fix
    if (!this.getStoreValue('energy_reset_v1')) {
      this.setStoreValue('thermal_energy', 0).catch(this.error);
      this.setStoreValue('energy_reset_v1', true).catch(this.error);
      this.setCapabilityValue('meter_power.heat', 0).catch(this.error);
      this._thermalEnergy = 0;
      this.log('Reset thermal energy accumulator (one-time fix)');
    } else {
      this._thermalEnergy = this.getStoreValue('thermal_energy') || 0;
    }
  }

  async repairCapabilities() {
    const requiredCapabilities = [
      'onoff',
      'target_temperature',
      'thermostat_mode',
      'measure_temperature',
      'measure_temperature.water_outlet',
      'measure_temperature.water_inlet',
      'measure_temperature.outdoor',
      'measure_temperature.room',
      'silent_mode',
      'control_method',
      'odu_cycle',
      'measure_power',
      'meter_power',
      'measure_power.heat',
      'meter_power.heat',
      'measure_cop',
      'measure_pressure',
      'measure_water',
      'alarm_generic',
      'error_code',
      'compressor_status',
      'defrosting_status',
      'water_pump_status'
    ];

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
        this.log(`Registered missing ${cap} capability`);
      }
    }

    // Remove old custom capabilities that have been replaced by standard ones
    const obsoleteCapabilities = [
      'operation_mode',
      'heating_cooling_enabled',
      'measure_water_pressure',
      'flow_rate',
      'target_temperature_dhw'
    ];

    for (const cap of obsoleteCapabilities) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap);
        this.log(`Removed obsolete ${cap} capability`);
      }
    }

    // Add/remove optional feature capabilities based on settings
    await this.updateOptionalCapabilities('dhw_installed', [
      'measure_temperature.dhw', 'target_temperature.dhw', 'dhw_enabled', 'dhw_heating_status'
    ]);
    await this.updateOptionalCapabilities('backup_heater_installed', [
      'measure_temperature.backup_heater'
    ]);
  }

  async updateOptionalCapabilities(settingKey, capabilities) {
    const enabled = this.settings[settingKey] !== false;
    for (const cap of capabilities) {
      if (enabled && !this.hasCapability(cap)) {
        await this.addCapability(cap);
        this.log(`Added capability: ${cap}`);
      } else if (!enabled && this.hasCapability(cap)) {
        await this.removeCapability(cap);
        this.log(`Removed capability: ${cap}`);
      }
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    // Update settings
    this.settings = newSettings;

    // Apply connection timeout changes
    if (changedKeys.includes('connection_timeout')) {
      this.modbus.connectionTimeout = newSettings.connection_timeout;
      this.log(`Connection timeout updated to ${newSettings.connection_timeout}ms`);
    }

    // Apply max consecutive errors changes
    if (changedKeys.includes('max_consecutive_errors')) {
      this.maxConsecutiveErrors = newSettings.max_consecutive_errors;
      this.log(`Max consecutive errors updated to ${newSettings.max_consecutive_errors}`);
    }

    // Toggle optional capabilities based on feature settings
    if (changedKeys.includes('dhw_installed')) {
      await this.updateOptionalCapabilities('dhw_installed', [
        'measure_temperature.dhw', 'target_temperature.dhw', 'dhw_enabled', 'dhw_heating_status'
      ]);
    }
    if (changedKeys.includes('backup_heater_installed')) {
      await this.updateOptionalCapabilities('backup_heater_installed', [
        'measure_temperature.backup_heater'
      ]);
    }

    // Restart polling if connection settings changed
    if (changedKeys.includes('ip') || changedKeys.includes('port') || changedKeys.includes('slave_id') || changedKeys.includes('poll_interval')) {
      this.restartPolling();
    }
  }

  setupModbusHandlers() {
    this.modbus.on('connect', () => {
      this.setAvailable();
      this.consecutiveErrors = 0;
      this._staticInfoLoaded = false;
      this.log('Connected to Modbus device');
    });

    this.modbus.on('error', (error) => {
      this.log('Modbus connection error:', error.message);
    });

    this.modbus.on('close', () => {
      this.log('Modbus connection closed - will attempt reconnection');
    });
  }

  async connectModbus() {
    if (this.modbus.isConnected()) {
      return true;
    }

    try {
      this.log(`Connecting to ${this.settings.ip}:${this.settings.port || 502} (slave ${this.settings.slave_id || 2})...`);
      const success = await this.modbus.connect({
        ip: this.settings.ip,
        port: this.settings.port || 502
      });

      if (success) {
        this.log('TCP connection established');
      }
      return success;
    } catch (error) {
      this.log('Modbus connection failed:', error);
      return false;
    }
  }

  disconnectModbus() {
    if (this.modbus) {
      this.modbus.disconnect();
      this.log('Disconnected from Modbus device');
    }
  }

  startPolling() {
    this.stopPolling();

    const interval = (this.settings.poll_interval || 120) * 1000;
    this.pollInterval = setInterval(async () => {
      await this.pollData();
    }, interval);

    // Initial poll
    setTimeout(() => this.pollData(), 1000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  restartPolling() {
    this.stopPolling();
    this.disconnectModbus();
    this.log(`Reconnecting to ${this.settings.ip}:${this.settings.port || 502}`);
    this.startPolling();
  }

  // Read static device info on connect (product group/info)
  async processDeviceStaticInfo(slaveId) {
    try {
      // Product Group (Input register 39998, address 9997)
      const reg_product_group = await this.modbus.readInputRegisters(slaveId, 9997, 1);
      const productGroup = ModbusClient.bufferToUint16(Buffer.concat(reg_product_group));

      // Product Info (Input register 39999, address 9998)
      const reg_product_info = await this.modbus.readInputRegisters(slaveId, 9998, 1);
      const productInfoVal = ModbusClient.bufferToUint16(Buffer.concat(reg_product_info));

      const productInfoNames = {
        0: 'Split',
        3: 'Monobloc',
        4: 'High Temp',
        5: 'Med Temp',
        6: 'System Boiler'
      };
      const productInfoStr = productInfoNames[productInfoVal] || `Unknown (${productInfoVal})`;

      this.log(`Product group: ${productGroup}, Product info: ${productInfoStr}`);

      this.setSettings({
        'product_group': String(productGroup),
        'product_info': productInfoStr
      });
    } catch (error) {
      this.log('Device static info error:', error);
    }
  }

  async pollData() {
    if (this._isDeleted) {
      return;
    }

    // Prevent concurrent polls through the serial gateway
    if (this._polling) {
      this.log('Poll already in progress, skipping');
      return;
    }
    this._polling = true;

    if (!await this.connectModbus()) {
      this._polling = false;
      this.consecutiveErrors++;
      this.log(`Connection failed (${this.consecutiveErrors}/${this.maxConsecutiveErrors})`);

      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this.setUnavailable(`Connection failed after ${this.maxConsecutiveErrors} attempts`);
      }
      return;
    }

    try {
      const slaveId = this.settings.slave_id || 2;

      // Small delay helper - serial gateway needs time between requests
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      // Read discrete inputs (status booleans)
      this.log('Polling discrete inputs...');
      await this.processDiscreteInputs(slaveId);
      await delay(500);

      // Read input registers (measurements)
      this.log('Polling input registers...');
      await this.processInputRegisters(slaveId);
      await delay(500);

      // Read coil states (control booleans)
      this.log('Polling coil states...');
      await this.processCoilStates(slaveId);
      await delay(500);

      // Read holding registers (settings/modes)
      this.log('Polling holding registers...');
      await this.processHoldingRegisters(slaveId);
      await delay(500);

      // Read energy registers (LG built-in energy metering)
      this.log('Polling energy registers...');
      await this.processEnergyRegisters(slaveId);

      // Load static device info after critical reads succeed (high address range, non-essential)
      if (!this._staticInfoLoaded) {
        await delay(500);
        this.log('Loading static device info...');
        await this.processDeviceStaticInfo(slaveId);
        this._staticInfoLoaded = true;
      }

      // Successful poll - reset error counter
      this.consecutiveErrors = 0;
      if (!this._isDeleted && !this.getAvailable()) {
        this.setAvailable();
      }

    } catch (error) {
      this.consecutiveErrors++;
      this.log(`Polling error (${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);

      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this.setUnavailable(`Polling failed ${this.maxConsecutiveErrors} times: ${error.message}`);
      }
    } finally {
      this._polling = false;
    }
  }

  // ============================================
  // DISCRETE INPUTS (FC 0x02) - Status booleans
  // Read addresses: 10001-10017 → wire addresses 0-16
  // ============================================
  async processDiscreteInputs(slaveId) {
    try {
      // Read 17 discrete inputs starting at address 0 (10001-10017)
      // modbus-pdu returns an array of bit values (0 or 1), not buffers
      const bits = await this.modbus.readDiscreteInputs(slaveId, 0, 17);

      // 10002 (bit 1): Water Pump status
      const waterPump = bits[1] === 1;
      const prevWaterPump = this.getCapabilityValue('water_pump_status');
      if (prevWaterPump !== waterPump) {
        this.setCapabilityValue('water_pump_status', waterPump).catch(this.error);
      }

      // 10004 (bit 3): Compressor status
      const compressor = bits[3] === 1;
      const prevCompressor = this.getCapabilityValue('compressor_status');
      if (prevCompressor !== compressor) {
        this.setCapabilityValue('compressor_status', compressor).catch(this.error);
        // Trigger compressor started/stopped
        if (prevCompressor !== null && prevCompressor !== undefined) {
          if (compressor) {
            this.homey.flow.getDeviceTriggerCard('compressor_started')
              .trigger(this, {}, {}).catch(this.error);
          } else {
            this.homey.flow.getDeviceTriggerCard('compressor_stopped')
              .trigger(this, {}, {}).catch(this.error);
          }
        }
      }

      // 10005 (bit 4): Defrost status
      const defrosting = bits[4] === 1;
      const prevDefrosting = this.getCapabilityValue('defrosting_status');
      if (prevDefrosting !== defrosting) {
        this.setCapabilityValue('defrosting_status', defrosting).catch(this.error);
        // Trigger defrosting started/stopped
        if (prevDefrosting !== null && prevDefrosting !== undefined) {
          if (defrosting) {
            this.homey.flow.getDeviceTriggerCard('defrosting_started')
              .trigger(this, {}, {}).catch(this.error);
          } else {
            this.homey.flow.getDeviceTriggerCard('defrosting_stopped')
              .trigger(this, {}, {}).catch(this.error);
          }
        }
      }

      // 10006 (bit 5): DHW heating status
      if (this.hasCapability('dhw_heating_status')) {
        const dhwHeating = bits[5] === 1;
        const prevDhwHeating = this.getCapabilityValue('dhw_heating_status');
        if (prevDhwHeating !== dhwHeating) {
          this.setCapabilityValue('dhw_heating_status', dhwHeating).catch(this.error);
          // Trigger DHW heating started/stopped
          if (prevDhwHeating !== null && prevDhwHeating !== undefined) {
            if (dhwHeating) {
              this.homey.flow.getDeviceTriggerCard('dhw_heating_started')
                .trigger(this, {}, {}).catch(this.error);
            } else {
              this.homey.flow.getDeviceTriggerCard('dhw_heating_stopped')
                .trigger(this, {}, {}).catch(this.error);
            }
          }
        }
      }

      // 10014 (bit 13): Error status → alarm_generic
      const hasError = bits[13] === 1;
      const prevError = this.getCapabilityValue('alarm_generic');
      if (prevError !== hasError) {
        this.setCapabilityValue('alarm_generic', hasError).catch(this.error);
        if (!hasError && prevError) {
          this.homey.flow.getDeviceTriggerCard('error_cleared')
            .trigger(this, {}, {}).catch(this.error);
          this.unsetWarning();
        }
      }

    } catch (error) {
      this.log('Error processing discrete inputs:', error);
    }
  }

  // ============================================
  // INPUT REGISTERS (FC 0x04) - Measurements
  // Read addresses: 30001-30014 → wire addresses 0-13
  // ============================================
  async processInputRegisters(slaveId) {
    try {
      // Read 14 input registers starting at address 0 (30001-30014)
      const result = await this.modbus.readInputRegisters(slaveId, 0, 14);
      const buffer = Buffer.concat(result);

      // 30001 (offset 0): Error code
      const errorCode = ModbusClient.bufferToUint16(buffer.subarray(0, 2));
      const prevErrorCode = this.getCapabilityValue('error_code');
      if (prevErrorCode !== errorCode) {
        this.setCapabilityValue('error_code', errorCode).catch(this.error);
        if (errorCode > 0 && (prevErrorCode === 0 || prevErrorCode === null)) {
          this.homey.flow.getDeviceTriggerCard('error_detected')
            .trigger(this, { error_code: errorCode }, {}).catch(this.error);
          this.setWarning(`Error code: ${errorCode}`);
        }
      }

      // 30002 (offset 2): ODU operation cycle (0=Standby, 1=Cooling, 2=Heating)
      const oduCycleRaw = ModbusClient.bufferToUint16(buffer.subarray(2, 4));
      const oduCycleStr = this.driver.ODU_CYCLES[oduCycleRaw] || 'standby';
      const prevOduCycle = this.getCapabilityValue('odu_cycle');
      if (prevOduCycle !== oduCycleStr) {
        this.setCapabilityValue('odu_cycle', oduCycleStr).catch(this.error);
        if (prevOduCycle) {
          this.homey.flow.getDeviceTriggerCard('odu_cycle_changed')
            .trigger(this, { cycle: oduCycleStr }, {}).catch(this.error);
        }
      }

      // LG uses 0xFD77 (-649 signed, /10 = -64.9°C) as "no sensor" sentinel
      const LG_NO_SENSOR_RAW = -649;
      const isValidTemp = (raw) => raw !== LG_NO_SENSOR_RAW;

      // 30003 (offset 4): Water inlet temp [÷10 for °C]
      const waterInletRaw = ModbusClient.bufferToInt16(buffer.subarray(4, 6));
      const waterInletTemp = isValidTemp(waterInletRaw) ? waterInletRaw / 10 : null;
      if (waterInletTemp !== null) {
        this.setCapabilityValue('measure_temperature.water_inlet', waterInletTemp).catch(this.error);
      }

      // 30004 (offset 6): Water outlet temp [÷10 for °C]
      const waterOutletRaw = ModbusClient.bufferToInt16(buffer.subarray(6, 8));
      const waterOutletTemp = isValidTemp(waterOutletRaw) ? waterOutletRaw / 10 : null;
      if (waterOutletTemp !== null) {
        this.setCapabilityValue('measure_temperature.water_outlet', waterOutletTemp).catch(this.error);
      }

      // 30005 (offset 8): Backup heater outlet temp [÷10 for °C]
      if (this.hasCapability('measure_temperature.backup_heater')) {
        const backupHeaterRaw = ModbusClient.bufferToInt16(buffer.subarray(8, 10));
        const backupHeaterTemp = isValidTemp(backupHeaterRaw) ? backupHeaterRaw / 10 : null;
        if (backupHeaterTemp !== null) {
          this.setCapabilityValue('measure_temperature.backup_heater', backupHeaterTemp).catch(this.error);
        }
      }

      // 30006 (offset 10): DHW tank water temp [÷10 for °C]
      if (this.hasCapability('measure_temperature.dhw')) {
        const dhwRaw = ModbusClient.bufferToInt16(buffer.subarray(10, 12));
        const dhwTemp = isValidTemp(dhwRaw) ? dhwRaw / 10 : null;
        if (dhwTemp !== null) {
          this.setCapabilityValue('measure_temperature.dhw', dhwTemp).catch(this.error);
        }
      }

      // 30008 (offset 14): Room air temp Circuit 1 [÷10 for °C]
      const roomRaw = ModbusClient.bufferToInt16(buffer.subarray(14, 16));
      const roomTemp = isValidTemp(roomRaw) ? roomRaw / 10 : null;
      if (roomTemp !== null) {
        this.setCapabilityValue('measure_temperature.room', roomTemp).catch(this.error);
      }

      // Dynamic main measure_temperature: follows control method
      // room_air → room temp, water_outlet/water_inlet → water outlet temp
      const controlMethod = this.getCapabilityValue('control_method');
      const mainTemp = (controlMethod === 'room_air') ? roomTemp : waterOutletTemp;
      if (mainTemp !== null) {
        this.setCapabilityValue('measure_temperature', mainTemp).catch(this.error);
      }

      // 30009 (offset 16): Current flow rate [÷10 for L/min] → measure_water (standard)
      const flowRate = ModbusClient.bufferToUint16(buffer.subarray(16, 18)) / 10;
      this.setCapabilityValue('measure_water', flowRate).catch(this.error);

      // 30013 (offset 24): Outdoor air temp [÷10 for °C]
      const outdoorRaw = ModbusClient.bufferToInt16(buffer.subarray(24, 26));
      const outdoorTemp = isValidTemp(outdoorRaw) ? outdoorRaw / 10 : null;
      if (outdoorTemp !== null) {
        this.setCapabilityValue('measure_temperature.outdoor', outdoorTemp).catch(this.error);
      }

      // 30014 (offset 26): Water pressure [÷10 for bar] → measure_pressure (standard)
      const waterPressure = ModbusClient.bufferToUint16(buffer.subarray(26, 28)) / 10;
      this.setCapabilityValue('measure_pressure', waterPressure).catch(this.error);

      // Calculate thermal output power from flow rate and delta T
      // Q(W) = flowRate(L/min) / 60 * 1000(g/L) * 4.186(J/g·°C) * deltaT(°C)
      // Simplified: Q(W) = flowRate * 69.77 * deltaT
      // Only calculate when compressor is actively running - residual flow/temps don't count
      let thermalPower = 0;
      const compressorOn = this.getCapabilityValue('compressor_status') === true;
      const waterPumpOn = this.getCapabilityValue('water_pump_status') === true;
      if (compressorOn && waterPumpOn && waterOutletTemp !== null && waterInletTemp !== null) {
        const deltaT = Math.abs(waterOutletTemp - waterInletTemp);
        thermalPower = Math.round(flowRate * 69.77 * deltaT);
      }
      this.setCapabilityValue('measure_power.heat', thermalPower).catch(this.error);

      // Accumulate thermal energy (kWh) over time
      const now = Date.now();
      if (this._lastPollTime && thermalPower > 0) {
        const hoursElapsed = (now - this._lastPollTime) / 3600000;
        this._thermalEnergy += (thermalPower / 1000) * hoursElapsed;
        this.setCapabilityValue('meter_power.heat', Math.round(this._thermalEnergy * 100) / 100).catch(this.error);
        // Persist to store every poll so it survives restarts
        this.setStoreValue('thermal_energy', this._thermalEnergy).catch(this.error);
      }
      this._lastPollTime = now;

    } catch (error) {
      this.log('Error processing input registers:', error);
    }
  }

  // ============================================
  // COIL STATES (FC 0x01) - Read coil status
  // Read addresses: 00001-00003 → wire addresses 0-2
  // ============================================
  async processCoilStates(slaveId) {
    try {
      // Read 3 coils starting at address 0 (00001-00003)
      // modbus-pdu returns an array of bit values (0 or 1), not buffers
      const bits = await this.modbus.readCoils(slaveId, 0, 3);

      // 00001 (bit 0): Enable/Disable Heating/Cooling → onoff (standard)
      const hcEnabled = bits[0] === 1;
      const prevHcEnabled = this.getCapabilityValue('onoff');
      if (prevHcEnabled !== hcEnabled) {
        this.setCapabilityValue('onoff', hcEnabled).catch(this.error);
      }

      // 00002 (bit 1): Enable/Disable DHW
      if (this.hasCapability('dhw_enabled')) {
        const dhwEnabled = bits[1] === 1;
        const prevDhwEnabled = this.getCapabilityValue('dhw_enabled');
        if (prevDhwEnabled !== dhwEnabled) {
          this.setCapabilityValue('dhw_enabled', dhwEnabled).catch(this.error);
        }
      }

      // 00003 (bit 2): Silent Mode
      const silentMode = bits[2] === 1;
      const prevSilentMode = this.getCapabilityValue('silent_mode');
      if (prevSilentMode !== silentMode) {
        this.setCapabilityValue('silent_mode', silentMode).catch(this.error);
      }

    } catch (error) {
      this.log('Error processing coil states:', error);
    }
  }

  // ============================================
  // HOLDING REGISTERS (FC 0x03) - Settings/modes
  // Read addresses: 40001-40009 → wire addresses 0-8
  // ============================================
  async processHoldingRegisters(slaveId) {
    try {
      // Read 9 holding registers starting at address 0 (40001-40009)
      const result = await this.modbus.readHoldingRegisters(slaveId, 0, 9);
      const buffer = Buffer.concat(result);

      // 40001 (offset 0): Operation mode
      const opModeRaw = ModbusClient.bufferToUint16(buffer.subarray(0, 2));
      const opModeStr = this.driver.OPERATION_MODES[opModeRaw] || 'auto';
      const prevOpMode = this.getCapabilityValue('thermostat_mode');
      if (prevOpMode !== opModeStr) {
        this.setCapabilityValue('thermostat_mode', opModeStr).catch(this.error);
      }

      // 40002 (offset 2): Control method - packed register, high byte = circuit 1 control method
      const ctrlMethodFull = ModbusClient.bufferToUint16(buffer.subarray(2, 4));
      const ctrlMethodRaw = (ctrlMethodFull >> 8) & 0xFF;
      const ctrlMethodStr = this.driver.CONTROL_METHODS[ctrlMethodRaw] || 'water_outlet';
      const prevCtrlMethod = this.getCapabilityValue('control_method');
      if (prevCtrlMethod !== ctrlMethodStr) {
        this.setCapabilityValue('control_method', ctrlMethodStr).catch(this.error);
      }

      // 40003 (offset 4): Target temp HC Circuit 1 [÷10 for °C]
      const targetTemp = ModbusClient.bufferToInt16(buffer.subarray(4, 6)) / 10;
      const prevTargetTemp = this.getCapabilityValue('target_temperature');
      if (prevTargetTemp !== targetTemp) {
        this.setCapabilityValue('target_temperature', targetTemp).catch(this.error);
      }

      // 40009 (offset 16): DHW target temp [÷10 for °C] → target_temperature.dhw (standard sub-cap)
      if (this.hasCapability('target_temperature.dhw')) {
        const dhwTargetTemp = ModbusClient.bufferToInt16(buffer.subarray(16, 18)) / 10;
        const prevDhwTarget = this.getCapabilityValue('target_temperature.dhw');
        if (prevDhwTarget !== dhwTargetTemp) {
          this.setCapabilityValue('target_temperature.dhw', dhwTargetTemp).catch(this.error);
        }
      }

    } catch (error) {
      this.log('Error processing holding registers:', error);
    }
  }

  // ============================================
  // ENERGY REGISTERS (FC 0x04) - LG built-in energy metering
  // Read addresses: 30037-30046 → wire addresses 36-45
  // 32-bit values split across high/low register pairs
  // ============================================
  async processEnergyRegisters(slaveId) {
    try {
      // Read 10 input registers starting at address 36 (30037-30046)
      const result = await this.modbus.readInputRegisters(slaveId, 36, 10);
      const buffer = Buffer.concat(result);

      // Helper: combine high+low 16-bit registers into 32-bit value
      // Uses multiplication instead of bit shift to avoid sign issues for values > 2^31
      const toUint32 = (offset) => {
        const high = ModbusClient.bufferToUint16(buffer.subarray(offset, offset + 2));
        const low = ModbusClient.bufferToUint16(buffer.subarray(offset + 2, offset + 4));
        return high * 65536 + low;
      };

      // 30037-30038 (offset 0-3): Instantaneous total power [W]
      const instantPower = toUint32(0);
      this.setCapabilityValue('measure_power', instantPower).catch(this.error);

      // 30039-30040 (offset 4-7): Accumulative total energy [Wh] → kWh
      const accumTotal = toUint32(4);
      this.setCapabilityValue('meter_power', Math.round(accumTotal / 10) / 100).catch(this.error);

      // Calculate COP = thermal output / electrical input
      const thermalPower = this.getCapabilityValue('measure_power.heat') || 0;
      if (instantPower > 0 && thermalPower > 0) {
        const cop = Math.round((thermalPower / instantPower) * 10) / 10;
        this.setCapabilityValue('measure_cop', Math.min(cop, 15)).catch(this.error);
      } else {
        this.setCapabilityValue('measure_cop', 0).catch(this.error);
      }

    } catch (error) {
      this.log('Error processing energy registers:', error);
    }
  }

  // ============================================
  // CAPABILITY LISTENERS (write to Modbus)
  // ============================================

  setupCapabilityListeners() {
    // onoff (standard) → Coil 00001 (address 0): Enable/Disable Heating/Cooling
    this.registerCapabilityListener('onoff', async (value) => {
      await this.writeCoil(0, value);
      this.log(`Heating/Cooling set to: ${value}`);
    });

    // thermostat_mode (standard) → Holding register 40001 (address 0)
    this.registerCapabilityListener('thermostat_mode', async (value) => {
      const modeValue = Object.keys(this.driver.OPERATION_MODES).find(
        key => this.driver.OPERATION_MODES[key] === value
      );
      if (modeValue !== undefined) {
        await this.writeHoldingRegister(0, parseInt(modeValue));
        this.log(`Thermostat mode set to: ${value} (register value: ${modeValue})`);
      }
    });

    // target_temperature (standard) → Holding register 40003 (address 2), multiply by 10
    this.registerCapabilityListener('target_temperature', async (value) => {
      const registerValue = Math.round(value * 10);
      await this.writeHoldingRegister(2, registerValue);
      this.log(`Target temperature set to: ${value}°C (register value: ${registerValue})`);
    });

    // target_temperature.dhw (standard sub-cap) → Holding register 40009 (address 8), multiply by 10
    if (this.hasCapability('target_temperature.dhw')) {
      this.registerCapabilityListener('target_temperature.dhw', async (value) => {
        const registerValue = Math.round(value * 10);
        await this.writeHoldingRegister(8, registerValue);
        this.log(`DHW target temperature set to: ${value}°C (register value: ${registerValue})`);
      });
    }

    // DHW enable → Coil 00002 (address 1)
    if (this.hasCapability('dhw_enabled')) {
      this.registerCapabilityListener('dhw_enabled', async (value) => {
        await this.writeCoil(1, value);
        this.log(`DHW set to: ${value}`);
      });
    }

    // Silent mode → Coil 00003 (address 2)
    this.registerCapabilityListener('silent_mode', async (value) => {
      await this.writeCoil(2, value);
      this.log(`Silent mode set to: ${value}`);
    });

    // Control method → Holding register 40002 (address 1)
    this.registerCapabilityListener('control_method', async (value) => {
      const methodValue = Object.keys(this.driver.CONTROL_METHODS).find(
        key => this.driver.CONTROL_METHODS[key] === value
      );
      if (methodValue !== undefined) {
        await this.writeHoldingRegister(1, parseInt(methodValue));
        this.log(`Control method set to: ${value} (register value: ${methodValue})`);
      }
    });

    this.log('Capability listeners registered');
  }

  // Helper: write a single coil with connection check
  async writeCoil(address, value) {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 2;
    await this.modbus.writeSingleCoil(slaveId, address, value);
  }

  // Helper: write a single holding register with connection check
  async writeHoldingRegister(address, value) {
    if (!await this.connectModbus()) {
      throw new Error('Modbus connection failed');
    }
    const slaveId = this.settings.slave_id || 2;
    await this.modbus.writeSingleRegister(slaveId, address, value);
  }

  // ============================================
  // FLOW CARD TRIGGERS
  // ============================================

  registerFlowCardTriggers() {
    // All trigger cards are device trigger cards registered via getDeviceTriggerCard
    // They are triggered inline during polling when values change
    // Standard capabilities (onoff, thermostat_mode, target_temperature, alarm_generic)
    // have built-in trigger cards provided by Homey automatically
    this.log('Flow card triggers registered');
  }

  // ============================================
  // FLOW CARD CONDITIONS (custom only)
  // Standard conditions (thermostat_mode_is, alarm_generic) are built-in
  // ============================================

  async conditionOduCycleIs(args) {
    const cycle = this.getCapabilityValue('odu_cycle');
    return cycle === args.cycle;
  }

  async conditionIsHeating() {
    const cycle = this.getCapabilityValue('odu_cycle');
    return cycle === 'heating';
  }

  async conditionIsCooling() {
    const cycle = this.getCapabilityValue('odu_cycle');
    return cycle === 'cooling';
  }

  async conditionIsDefrosting() {
    const defrosting = this.getCapabilityValue('defrosting_status');
    return defrosting === true;
  }

  async conditionCompressorIsOn() {
    const compressor = this.getCapabilityValue('compressor_status');
    return compressor === true;
  }

  async conditionDhwIsActive() {
    const dhwHeating = this.getCapabilityValue('dhw_heating_status');
    return dhwHeating === true;
  }

  async conditionTemperatureAbove(args) {
    const temperature = this.getCapabilityValue('measure_temperature');
    return temperature > args.temperature;
  }

  async conditionWaterPressureBelow(args) {
    const pressure = this.getCapabilityValue('measure_pressure');
    return pressure < args.pressure;
  }

  // ============================================
  // FLOW CARD ACTIONS (custom only)
  // Standard actions (thermostat_mode_set, target_temperature_set, on/off) are built-in
  // ============================================

  async actionSetDhwTargetTemperature(args) {
    try {
      const registerValue = Math.round(args.temperature * 10);
      await this.writeHoldingRegister(8, registerValue);
      await this.setCapabilityValue('target_temperature.dhw', args.temperature);
      this.log(`DHW target temperature set to: ${args.temperature}°C`);
      return true;
    } catch (error) {
      this.log('Error setting DHW target temperature:', error);
      throw error;
    }
  }

  async actionEnableDhw() {
    try {
      await this.writeCoil(1, true);
      await this.setCapabilityValue('dhw_enabled', true);
      this.log('DHW enabled');
      return true;
    } catch (error) {
      this.log('Error enabling DHW:', error);
      throw error;
    }
  }

  async actionDisableDhw() {
    try {
      await this.writeCoil(1, false);
      await this.setCapabilityValue('dhw_enabled', false);
      this.log('DHW disabled');
      return true;
    } catch (error) {
      this.log('Error disabling DHW:', error);
      throw error;
    }
  }

  async actionEnableSilentMode() {
    try {
      await this.writeCoil(2, true);
      await this.setCapabilityValue('silent_mode', true);
      this.log('Silent mode enabled');
      return true;
    } catch (error) {
      this.log('Error enabling silent mode:', error);
      throw error;
    }
  }

  async actionDisableSilentMode() {
    try {
      await this.writeCoil(2, false);
      await this.setCapabilityValue('silent_mode', false);
      this.log('Silent mode disabled');
      return true;
    } catch (error) {
      this.log('Error disabling silent mode:', error);
      throw error;
    }
  }

  async actionSetControlMethod(args) {
    try {
      const methodValue = Object.keys(this.driver.CONTROL_METHODS).find(
        key => this.driver.CONTROL_METHODS[key] === args.method
      );
      if (methodValue === undefined) {
        throw new Error(`Unknown control method: ${args.method}`);
      }
      await this.writeHoldingRegister(1, parseInt(methodValue));
      await this.setCapabilityValue('control_method', args.method);
      this.log(`Control method set to: ${args.method}`);
      return true;
    } catch (error) {
      this.log('Error setting control method:', error);
      throw error;
    }
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  async onDeleted() {
    this.log('LG AWHP Device deleted');
    this._isDeleted = true;
    this.stopPolling();
    this.disconnectModbus();
  }
}

module.exports = LGAWHPDevice;
