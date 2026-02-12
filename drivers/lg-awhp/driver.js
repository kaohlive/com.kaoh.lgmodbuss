'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class LGAWHPDriver extends Homey.Driver {

  // LG Operation modes (Holding register 40001)
  // Values match standard thermostat_mode capability: cool, heat, auto
  OPERATION_MODES = {
    0: 'cool',
    4: 'heat',
    3: 'auto'
  };

  // ODU cycle states (Input register 30002)
  ODU_CYCLES = {
    0: 'standby',
    1: 'cooling',
    2: 'heating'
  };

  // Control methods (Holding register 40002)
  CONTROL_METHODS = {
    0: 'water_outlet',
    1: 'water_inlet',
    2: 'room_air'
  };

  async onInit() {
    this.log('LGAWHPDriver has been initialized');

    // Register flow card conditions (only custom ones, standard capabilities have built-in cards)
    this.registerFlowCardConditions();

    // Register flow card actions (only custom ones)
    this.registerFlowCardActions();
  }

  registerFlowCardConditions() {
    // ODU cycle is condition
    this.homey.flow.getConditionCard('odu_cycle_is')
      .registerRunListener(async (args) => {
        return await args.device.conditionOduCycleIs(args);
      });

    // Is heating condition (checks ODU cycle, not thermostat_mode)
    this.homey.flow.getConditionCard('is_heating')
      .registerRunListener(async (args) => {
        return await args.device.conditionIsHeating();
      });

    // Is cooling condition
    this.homey.flow.getConditionCard('is_cooling')
      .registerRunListener(async (args) => {
        return await args.device.conditionIsCooling();
      });

    // Is defrosting condition
    this.homey.flow.getConditionCard('is_defrosting')
      .registerRunListener(async (args) => {
        return await args.device.conditionIsDefrosting();
      });

    // Compressor is on condition
    this.homey.flow.getConditionCard('compressor_is_on')
      .registerRunListener(async (args) => {
        return await args.device.conditionCompressorIsOn();
      });

    // DHW is active condition
    this.homey.flow.getConditionCard('dhw_is_active')
      .registerRunListener(async (args) => {
        return await args.device.conditionDhwIsActive();
      });

    // Temperature above condition
    this.homey.flow.getConditionCard('temperature_above')
      .registerRunListener(async (args) => {
        return await args.device.conditionTemperatureAbove(args);
      });

    // Water pressure below condition
    this.homey.flow.getConditionCard('water_pressure_below')
      .registerRunListener(async (args) => {
        return await args.device.conditionWaterPressureBelow(args);
      });
  }

  registerFlowCardActions() {
    // Set DHW target temperature action
    this.homey.flow.getActionCard('set_dhw_target_temperature')
      .registerRunListener(async (args) => {
        return await args.device.actionSetDhwTargetTemperature(args);
      });

    // Enable DHW action
    this.homey.flow.getActionCard('enable_dhw')
      .registerRunListener(async (args) => {
        return await args.device.actionEnableDhw();
      });

    // Disable DHW action
    this.homey.flow.getActionCard('disable_dhw')
      .registerRunListener(async (args) => {
        return await args.device.actionDisableDhw();
      });

    // Enable silent mode action
    this.homey.flow.getActionCard('enable_silent_mode')
      .registerRunListener(async (args) => {
        return await args.device.actionEnableSilentMode();
      });

    // Disable silent mode action
    this.homey.flow.getActionCard('disable_silent_mode')
      .registerRunListener(async (args) => {
        return await args.device.actionDisableSilentMode();
      });

    // Set control method action
    this.homey.flow.getActionCard('set_control_method')
      .registerRunListener(async (args) => {
        return await args.device.actionSetControlMethod(args);
      });
  }

  async onPair(session) {
    session.setHandler('test_connection', async (data) => {
      this.log(`Testing connection to ${data.ip}:${data.port} (slave ${data.slave_id})`);

      const client = new ModbusClient();
      try {
        const connected = await client.connect({ ip: data.ip, port: data.port });
        if (!connected) {
          return { success: false, message: 'Could not connect to gateway' };
        }

        // Try reading operation mode register to verify LG heat pump responds
        await client.readHoldingRegisters(data.slave_id, 0, 1);
        client.disconnect();

        this.log('Connection test successful');
        return { success: true };
      } catch (err) {
        this.log('Connection test failed:', err.message);
        client.disconnect();
        return { success: false, message: err.message };
      }
    });
  }
}

module.exports = LGAWHPDriver;
