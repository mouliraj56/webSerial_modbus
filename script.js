/**
 * Modbus RTU Master Emulator
 * A production-ready Web-Based Modbus RTU Master Application
 * 
 * Uses Web Serial API to communicate with physical Modbus RTU devices
 * through USB-RS485 adapters.
 */

'use strict';

// ============================================
// Constants
// ============================================
const MODBUS_EXCEPTIONS = {
    0x01: 'Illegal Function',
    0x02: 'Illegal Data Address',
    0x03: 'Illegal Data Value',
    0x04: 'Slave Device Failure',
    0x05: 'Acknowledge',
    0x06: 'Slave Device Busy',
    0x08: 'Memory Parity Error',
    0x0A: 'Gateway Path Unavailable',
    0x0B: 'Gateway Target Device Failed to Respond'
};

const FUNCTION_CODES = {
    READ_COILS: 0x01,
    READ_DISCRETE_INPUTS: 0x02,
    READ_HOLDING_REGISTERS: 0x03,
    READ_INPUT_REGISTERS: 0x04,
    WRITE_SINGLE_COIL: 0x05,
    WRITE_SINGLE_REGISTER: 0x06,
    WRITE_MULTIPLE_COILS: 0x0F,
    WRITE_MULTIPLE_REGISTERS: 0x10
};

const REGISTER_TYPES = {
    '0x': { name: 'Coil', readFC: 0x01, writeFC: 0x05, writeMultiFC: 0x0F },
    '1x': { name: 'Discrete Input', readFC: 0x02, writeFC: null, writeMultiFC: null },
    '3x': { name: 'Input Register', readFC: 0x04, writeFC: null, writeMultiFC: null },
    '4x': { name: 'Holding Register', readFC: 0x03, writeFC: 0x06, writeMultiFC: 0x10 }
};

const STORAGE_KEY = 'modbus_emulator_data';
const RESPONSE_TIMEOUT = 2000;
const MAX_REGISTERS_PER_READ = 125;
const MAX_COILS_PER_READ = 2000;

// ============================================
// Serial Communication Manager
// ============================================
class SerialManager {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        this.receiveBuffer = [];
        this.readLoopActive = false;
        this.responseCallback = null;
        this.portInfo = null;
    }

    /**
     * Check if Web Serial API is supported
     */
    static isSupported() {
        return 'serial' in navigator;
    }

    /**
     * Request a serial port from the user
     */
    async requestPort() {
        if (!SerialManager.isSupported()) {
            throw new Error('Web Serial API is not supported in this browser');
        }
        this.port = await navigator.serial.requestPort();
        this.portInfo = this.port.getInfo();
        return this.port;
    }

    /**
     * Connect to the serial port with specified settings
     */
    async connect(baudRate = 9600, parity = 'none', dataBits = 8, stopBits = 1) {
        if (!this.port) {
            throw new Error('No port selected');
        }

        await this.port.open({
            baudRate: parseInt(baudRate),
            parity: parity,
            dataBits: parseInt(dataBits),
            stopBits: parseInt(stopBits),
            bufferSize: 4096,
            flowControl: 'none'
        });

        this.writer = this.port.writable.getWriter();
        this.isConnected = true;
        this.startReading();

        return true;
    }

    /**
     * Disconnect from the serial port
     */
    async disconnect() {
        this.readLoopActive = false;

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (e) {
                // Ignore errors during cancel
            }
            this.reader.releaseLock();
            this.reader = null;
        }

        if (this.writer) {
            try {
                await this.writer.close();
            } catch (e) {
                // Ignore errors during close
            }
            this.writer.releaseLock();
            this.writer = null;
        }

        if (this.port) {
            try {
                await this.port.close();
            } catch (e) {
                // Ignore errors during close
            }
        }

        this.isConnected = false;
        this.receiveBuffer = [];
    }

    /**
     * Write data to the serial port
     */
    async write(data) {
        if (!this.isConnected || !this.writer) {
            throw new Error('Not connected');
        }
        const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);
        await this.writer.write(uint8Data);
    }

    /**
     * Start continuous reading from the serial port
     */
    async startReading() {
        if (this.readLoopActive) return;
        this.readLoopActive = true;
        this.reader = this.port.readable.getReader();

        try {
            while (this.readLoopActive) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    this.receiveBuffer.push(...value);
                    this.processReceivedData();
                }
            }
        } catch (error) {
            if (this.readLoopActive) {
                console.error('Read error:', error);
            }
        } finally {
            if (this.reader) {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
    }

    /**
     * Process received data and trigger callbacks
     */
    processReceivedData() {
        if (this.responseCallback && this.receiveBuffer.length > 0) {
            // Give a small delay to accumulate complete response
            clearTimeout(this.processTimeout);
            this.processTimeout = setTimeout(() => {
                if (this.responseCallback) {
                    const data = new Uint8Array(this.receiveBuffer);
                    this.receiveBuffer = [];
                    this.responseCallback(data);
                    this.responseCallback = null;
                }
            }, 50);
        }
    }

    /**
     * Send data and wait for response with timeout
     */
    async sendWithTimeout(frame, timeoutMs = RESPONSE_TIMEOUT) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.responseCallback = null;
                reject(new Error('Response timeout'));
            }, timeoutMs);

            this.responseCallback = (data) => {
                clearTimeout(timeout);
                resolve(data);
            };

            this.receiveBuffer = []; // Clear buffer before sending
            this.write(frame).catch(reject);
        });
    }

    /**
     * Get port name/info as string
     */
    getPortName() {
        if (this.portInfo) {
            if (this.portInfo.usbVendorId) {
                return `USB (${this.portInfo.usbVendorId.toString(16).toUpperCase()}:${this.portInfo.usbProductId?.toString(16).toUpperCase() || '???'})`;
            }
        }
        return 'Serial Port';
    }
}

// ============================================
// Modbus Protocol Handler
// ============================================
class ModbusMaster {
    constructor(slaveId = 1) {
        this.slaveId = slaveId;
    }

    /**
     * Calculate CRC-16 (Modbus polynomial 0xA001)
     */
    static calculateCRC16(buffer) {
        let crc = 0xFFFF;

        for (let i = 0; i < buffer.length; i++) {
            crc ^= buffer[i];

            for (let j = 0; j < 8; j++) {
                if (crc & 0x0001) {
                    crc = (crc >> 1) ^ 0xA001;
                } else {
                    crc >>= 1;
                }
            }
        }

        return crc;
    }

    /**
     * Validate CRC of received frame
     */
    static validateCRC(frame) {
        if (frame.length < 4) return false;

        const data = frame.slice(0, -2);
        const receivedCRC = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
        const calculatedCRC = ModbusMaster.calculateCRC16(data);

        return receivedCRC === calculatedCRC;
    }

    /**
     * Append CRC to frame
     */
    static appendCRC(frame) {
        const crc = ModbusMaster.calculateCRC16(frame);
        return new Uint8Array([...frame, crc & 0xFF, (crc >> 8) & 0xFF]);
    }

    /**
     * Convert user address to Modbus address
     * e.g., 40001 → 0x0000 for Holding Register
     */
    static convertAddress(userAddress, registerType) {
        const addr = parseInt(userAddress);

        if (registerType === '4x') {
            return (addr >= 40001 && addr <= 49999) ? addr - 40001 : addr;
        } else if (registerType === '3x') {
            return (addr >= 30001 && addr <= 39999) ? addr - 30001 : addr;
        } else if (registerType === '0x') {
            return (addr >= 1 && addr <= 9999) ? addr - 1 : addr;
        } else if (registerType === '1x') {
            return (addr >= 10001 && addr <= 19999) ? addr - 10001 : addr;
        }

        return addr;
    }

    /**
     * Build Read Registers/Coils frame
     */
    buildReadFrame(functionCode, startAddress, quantity) {
        const frame = new Uint8Array([
            this.slaveId,
            functionCode,
            (startAddress >> 8) & 0xFF,
            startAddress & 0xFF,
            (quantity >> 8) & 0xFF,
            quantity & 0xFF
        ]);
        return ModbusMaster.appendCRC(frame);
    }

    /**
     * Build Write Single Register frame (FC06)
     */
    buildWriteSingleRegisterFrame(address, value) {
        const frame = new Uint8Array([
            this.slaveId,
            FUNCTION_CODES.WRITE_SINGLE_REGISTER,
            (address >> 8) & 0xFF,
            address & 0xFF,
            (value >> 8) & 0xFF,
            value & 0xFF
        ]);
        return ModbusMaster.appendCRC(frame);
    }

    /**
     * Build Write Single Coil frame (FC05)
     */
    buildWriteSingleCoilFrame(address, value) {
        const coilValue = value ? 0xFF00 : 0x0000;
        const frame = new Uint8Array([
            this.slaveId,
            FUNCTION_CODES.WRITE_SINGLE_COIL,
            (address >> 8) & 0xFF,
            address & 0xFF,
            (coilValue >> 8) & 0xFF,
            coilValue & 0xFF
        ]);
        return ModbusMaster.appendCRC(frame);
    }

    /**
     * Build Write Multiple Registers frame (FC16)
     */
    buildWriteMultipleRegistersFrame(startAddress, values) {
        const byteCount = values.length * 2;
        const frame = new Uint8Array(7 + byteCount);

        frame[0] = this.slaveId;
        frame[1] = FUNCTION_CODES.WRITE_MULTIPLE_REGISTERS;
        frame[2] = (startAddress >> 8) & 0xFF;
        frame[3] = startAddress & 0xFF;
        frame[4] = (values.length >> 8) & 0xFF;
        frame[5] = values.length & 0xFF;
        frame[6] = byteCount;

        for (let i = 0; i < values.length; i++) {
            frame[7 + i * 2] = (values[i] >> 8) & 0xFF;
            frame[8 + i * 2] = values[i] & 0xFF;
        }

        return ModbusMaster.appendCRC(frame);
    }

    /**
     * Build Write Multiple Coils frame (FC15)
     */
    buildWriteMultipleCoilsFrame(startAddress, values) {
        const byteCount = Math.ceil(values.length / 8);
        const frame = new Uint8Array(7 + byteCount);

        frame[0] = this.slaveId;
        frame[1] = FUNCTION_CODES.WRITE_MULTIPLE_COILS;
        frame[2] = (startAddress >> 8) & 0xFF;
        frame[3] = startAddress & 0xFF;
        frame[4] = (values.length >> 8) & 0xFF;
        frame[5] = values.length & 0xFF;
        frame[6] = byteCount;

        for (let i = 0; i < values.length; i++) {
            if (values[i]) {
                frame[7 + Math.floor(i / 8)] |= (1 << (i % 8));
            }
        }

        return ModbusMaster.appendCRC(frame);
    }

    /**
     * Parse read response and extract register values
     */
    parseReadResponse(response, expectedFC) {
        if (!ModbusMaster.validateCRC(response)) {
            throw new Error('CRC validation failed');
        }

        const slaveId = response[0];
        const functionCode = response[1];

        // Check for exception response
        if (functionCode >= 0x80) {
            const exceptionCode = response[2];
            throw new Error(MODBUS_EXCEPTIONS[exceptionCode] || `Unknown exception: 0x${exceptionCode.toString(16)}`);
        }

        if (functionCode !== expectedFC) {
            throw new Error(`Unexpected function code: ${functionCode}`);
        }

        const byteCount = response[2];
        const data = response.slice(3, 3 + byteCount);

        // Parse based on function code
        if (expectedFC === FUNCTION_CODES.READ_HOLDING_REGISTERS ||
            expectedFC === FUNCTION_CODES.READ_INPUT_REGISTERS) {
            // Parse as 16-bit registers
            const values = [];
            for (let i = 0; i < byteCount; i += 2) {
                values.push((data[i] << 8) | data[i + 1]);
            }
            return values;
        } else if (expectedFC === FUNCTION_CODES.READ_COILS ||
                   expectedFC === FUNCTION_CODES.READ_DISCRETE_INPUTS) {
            // Parse as bits
            const values = [];
            for (let i = 0; i < byteCount; i++) {
                for (let bit = 0; bit < 8; bit++) {
                    values.push((data[i] >> bit) & 1);
                }
            }
            return values;
        }

        return data;
    }

    /**
     * Parse write response
     */
    parseWriteResponse(response, expectedFC) {
        if (!ModbusMaster.validateCRC(response)) {
            throw new Error('CRC validation failed');
        }

        const functionCode = response[1];

        // Check for exception response
        if (functionCode >= 0x80) {
            const exceptionCode = response[2];
            throw new Error(MODBUS_EXCEPTIONS[exceptionCode] || `Unknown exception: 0x${exceptionCode.toString(16)}`);
        }

        return true;
    }
}

// ============================================
// Value Interpreter
// ============================================
class ValueInterpreter {
    /**
     * Convert 16-bit value to unsigned
     */
    static toUnsigned16(value) {
        return value & 0xFFFF;
    }

    /**
     * Convert 16-bit value to signed
     */
    static toSigned16(value) {
        const unsigned = value & 0xFFFF;
        return unsigned > 32767 ? unsigned - 65536 : unsigned;
    }

    /**
     * Swap bytes in 16-bit value
     */
    static swapBytes(value) {
        return ((value & 0xFF) << 8) | ((value >> 8) & 0xFF);
    }

    /**
     * Convert two 16-bit registers to 32-bit float
     */
    static toFloat32(reg1, reg2, byteOrder = 'ABCD') {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);

        switch (byteOrder) {
            case 'ABCD': // Big-endian word, big-endian byte
                view.setUint16(0, reg1, false);
                view.setUint16(2, reg2, false);
                break;
            case 'CDAB': // Little-endian word, big-endian byte
                view.setUint16(0, reg2, false);
                view.setUint16(2, reg1, false);
                break;
            case 'BADC': // Big-endian word, little-endian byte
                view.setUint16(0, this.swapBytes(reg1), false);
                view.setUint16(2, this.swapBytes(reg2), false);
                break;
            case 'DCBA': // Little-endian word, little-endian byte
                view.setUint16(0, this.swapBytes(reg2), false);
                view.setUint16(2, this.swapBytes(reg1), false);
                break;
        }

        return view.getFloat32(0, false);
    }

    /**
     * Convert float to two 16-bit registers
     */
    static fromFloat32(value, byteOrder = 'ABCD') {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setFloat32(0, value, false);

        let reg1, reg2;

        switch (byteOrder) {
            case 'ABCD':
                reg1 = view.getUint16(0, false);
                reg2 = view.getUint16(2, false);
                break;
            case 'CDAB':
                reg1 = view.getUint16(2, false);
                reg2 = view.getUint16(0, false);
                break;
            case 'BADC':
                reg1 = this.swapBytes(view.getUint16(0, false));
                reg2 = this.swapBytes(view.getUint16(2, false));
                break;
            case 'DCBA':
                reg1 = this.swapBytes(view.getUint16(2, false));
                reg2 = this.swapBytes(view.getUint16(0, false));
                break;
        }

        return [reg1, reg2];
    }

    /**
     * Convert two registers to 32-bit long
     */
    static toLong32(reg1, reg2, byteOrder = 'ABCD') {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);

        switch (byteOrder) {
            case 'ABCD':
                view.setUint16(0, reg1, false);
                view.setUint16(2, reg2, false);
                break;
            case 'CDAB':
                view.setUint16(0, reg2, false);
                view.setUint16(2, reg1, false);
                break;
        }

        return view.getInt32(0, false);
    }

    /**
     * Convert four 16-bit registers to 64-bit double
     */
    static toFloat64(reg1, reg2, reg3, reg4, bigEndian = true) {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);

        if (bigEndian) {
            view.setUint16(0, reg1, false);
            view.setUint16(2, reg2, false);
            view.setUint16(4, reg3, false);
            view.setUint16(6, reg4, false);
        } else {
            view.setUint16(0, reg4, false);
            view.setUint16(2, reg3, false);
            view.setUint16(4, reg2, false);
            view.setUint16(6, reg1, false);
        }

        return view.getFloat64(0, false);
    }

    /**
     * Convert registers to ASCII string
     */
    static toString(registers) {
        let str = '';
        for (const reg of registers) {
            const highByte = (reg >> 8) & 0xFF;
            const lowByte = reg & 0xFF;
            if (highByte >= 32 && highByte <= 126) str += String.fromCharCode(highByte);
            if (lowByte >= 32 && lowByte <= 126) str += String.fromCharCode(lowByte);
        }
        return str;
    }

    /**
     * Format value as hex string
     */
    static toHexString(value, bits = 16) {
        const hex = (value >>> 0).toString(16).toUpperCase();
        const padLength = bits / 4;
        return '0x' + hex.padStart(padLength, '0');
    }

    /**
     * Format value as binary string
     */
    static toBinaryString(value, bits = 16) {
        return (value >>> 0).toString(2).padStart(bits, '0');
    }
}

// ============================================
// Traffic Logger
// ============================================
class TrafficLogger {
    constructor(maxEntries = 1000) {
        this.entries = [];
        this.maxEntries = maxEntries;
        this.isPaused = false;
        this.onUpdate = null;
    }

    /**
     * Log a traffic entry
     */
    log(direction, frame, error = null) {
        if (this.isPaused) return;

        const timestamp = new Date().toISOString().substring(11, 23);
        const hexString = Array.from(frame)
            .map(b => b.toString(16).padStart(2, '0').toUpperCase())
            .join(' ');

        this.entries.push({ timestamp, direction, hexString, error });

        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }

        if (this.onUpdate) {
            this.onUpdate(this.entries[this.entries.length - 1]);
        }
    }

    /**
     * Log an error
     */
    logError(message) {
        if (this.isPaused) return;

        const timestamp = new Date().toISOString().substring(11, 23);
        this.entries.push({ timestamp, direction: 'ERROR', hexString: message, error: true });

        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }

        if (this.onUpdate) {
            this.onUpdate(this.entries[this.entries.length - 1]);
        }
    }

    clear() {
        this.entries = [];
    }

    pause() {
        this.isPaused = true;
    }

    resume() {
        this.isPaused = false;
    }

    export() {
        return JSON.stringify(this.entries, null, 2);
    }
}

// ============================================
// Application State Store
// ============================================
class Store {
    constructor() {
        this.connections = [];
        this.slaves = [];
        this.registerGroups = [];
        this.registers = [];
        this.pollingIntervals = new Map();
        this.saveTimeout = null;
    }

    /**
     * Generate unique ID
     */
    generateId(prefix) {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Connection CRUD
    addConnection(config) {
        const connection = {
            id: this.generateId('conn'),
            portName: config.portName || 'Serial Port',
            baudRate: config.baudRate || 9600,
            parity: config.parity || 'none',
            dataBits: config.dataBits || 8,
            stopBits: config.stopBits || 1,
            isConnected: false,
            savedAt: new Date().toISOString()
        };
        this.connections.push(connection);
        this.scheduleSave();
        return connection;
    }

    updateConnection(id, updates) {
        const conn = this.connections.find(c => c.id === id);
        if (conn) {
            Object.assign(conn, updates);
            this.scheduleSave();
        }
        return conn;
    }

    removeConnection(id) {
        // Remove all related data
        const slaves = this.slaves.filter(s => s.connectionId === id);
        slaves.forEach(slave => this.removeSlave(slave.id));

        this.connections = this.connections.filter(c => c.id !== id);
        this.scheduleSave();
    }

    getConnection(id) {
        return this.connections.find(c => c.id === id);
    }

    // Slave CRUD
    addSlave(connectionId, slaveId, alias = '') {
        const slave = {
            id: this.generateId('slave'),
            connectionId,
            slaveId: parseInt(slaveId),
            alias: alias || `Slave ${slaveId}`
        };
        this.slaves.push(slave);
        this.scheduleSave();
        return slave;
    }

    updateSlave(id, updates) {
        const slave = this.slaves.find(s => s.id === id);
        if (slave) {
            Object.assign(slave, updates);
            this.scheduleSave();
        }
        return slave;
    }

    removeSlave(id) {
        // Remove all related register groups
        const groups = this.registerGroups.filter(g => g.slaveId === id);
        groups.forEach(group => this.removeRegisterGroup(group.id));

        this.slaves = this.slaves.filter(s => s.id !== id);
        this.scheduleSave();
    }

    getSlave(id) {
        return this.slaves.find(s => s.id === id);
    }

    getSlavesForConnection(connectionId) {
        return this.slaves.filter(s => s.connectionId === connectionId);
    }

    // Register Group CRUD
    addRegisterGroup(slaveId, name, pollingInterval = 1000) {
        const group = {
            id: this.generateId('group'),
            slaveId,
            name: name || 'Register Group',
            pollingInterval,
            autoPolling: false
        };
        this.registerGroups.push(group);
        this.scheduleSave();
        return group;
    }

    updateRegisterGroup(id, updates) {
        const group = this.registerGroups.find(g => g.id === id);
        if (group) {
            Object.assign(group, updates);
            this.scheduleSave();
        }
        return group;
    }

    removeRegisterGroup(id) {
        // Stop polling if active
        this.stopPolling(id);

        // Remove all related registers
        this.registers = this.registers.filter(r => r.groupId !== id);
        this.registerGroups = this.registerGroups.filter(g => g.id !== id);
        this.scheduleSave();
    }

    getRegisterGroup(id) {
        return this.registerGroups.find(g => g.id === id);
    }

    getGroupsForSlave(slaveId) {
        return this.registerGroups.filter(g => g.slaveId === slaveId);
    }

    // Register CRUD
    addRegister(groupId, config) {
        const register = {
            id: this.generateId('reg'),
            groupId,
            type: config.type || '4x',
            address: parseInt(config.address) || 0,
            alias: config.alias || '',
            value: 0,
            comment: config.comment || ''
        };
        this.registers.push(register);
        this.scheduleSave();
        return register;
    }

    addRegisters(groupId, configs) {
        const registers = configs.map(config => ({
            id: this.generateId('reg'),
            groupId,
            type: config.type || '4x',
            address: parseInt(config.address) || 0,
            alias: config.alias || '',
            value: 0,
            comment: config.comment || ''
        }));
        this.registers.push(...registers);
        this.scheduleSave();
        return registers;
    }

    updateRegister(id, updates) {
        const register = this.registers.find(r => r.id === id);
        if (register) {
            Object.assign(register, updates);
            // Don't save on value updates (too frequent)
            if (!updates.value) {
                this.scheduleSave();
            }
        }
        return register;
    }

    removeRegister(id) {
        this.registers = this.registers.filter(r => r.id !== id);
        this.scheduleSave();
    }

    getRegister(id) {
        return this.registers.find(r => r.id === id);
    }

    getRegistersForGroup(groupId) {
        return this.registers
            .filter(r => r.groupId === groupId)
            .sort((a, b) => a.address - b.address);
    }

    // Polling Management
    startPolling(groupId, callback) {
        const group = this.getRegisterGroup(groupId);
        if (!group) return;

        this.stopPolling(groupId);

        const intervalId = setInterval(callback, group.pollingInterval);
        this.pollingIntervals.set(groupId, intervalId);
        group.autoPolling = true;
    }

    stopPolling(groupId) {
        const intervalId = this.pollingIntervals.get(groupId);
        if (intervalId) {
            clearInterval(intervalId);
            this.pollingIntervals.delete(groupId);
        }
        const group = this.getRegisterGroup(groupId);
        if (group) {
            group.autoPolling = false;
        }
    }

    stopAllPolling() {
        this.pollingIntervals.forEach((intervalId) => {
            clearInterval(intervalId);
        });
        this.pollingIntervals.clear();
        this.registerGroups.forEach(g => g.autoPolling = false);
    }

    // Persistence
    scheduleSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => this.saveToLocalStorage(), 500);
    }

    saveToLocalStorage() {
        try {
            const data = {
                version: '1.0',
                connections: this.connections,
                slaves: this.slaves,
                registerGroups: this.registerGroups,
                registers: this.registers.map(r => ({
                    ...r,
                    value: undefined // Don't save volatile values
                }))
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (error) {
            console.error('Failed to save to localStorage:', error);
        }
    }

    loadFromLocalStorage() {
        try {
            const json = localStorage.getItem(STORAGE_KEY);
            if (!json) return false;

            const data = JSON.parse(json);

            if (data.version === '1.0') {
                this.connections = data.connections || [];
                this.slaves = data.slaves || [];
                this.registerGroups = data.registerGroups || [];
                this.registers = data.registers || [];

                // Reset connection states
                this.connections.forEach(c => c.isConnected = false);
                this.registerGroups.forEach(g => g.autoPolling = false);

                return true;
            }
        } catch (error) {
            console.error('Failed to load from localStorage:', error);
        }
        return false;
    }

    exportConfig() {
        return JSON.stringify({
            version: '1.0',
            exportedAt: new Date().toISOString(),
            connections: this.connections,
            slaves: this.slaves,
            registerGroups: this.registerGroups,
            registers: this.registers
        }, null, 2);
    }

    importConfig(json) {
        try {
            const data = JSON.parse(json);
            if (data.version === '1.0') {
                this.connections = data.connections || [];
                this.slaves = data.slaves || [];
                this.registerGroups = data.registerGroups || [];
                this.registers = data.registers || [];
                this.saveToLocalStorage();
                return true;
            }
        } catch (error) {
            console.error('Failed to import config:', error);
        }
        return false;
    }
}

// ============================================
// UI Manager
// ============================================
class UIManager {
    constructor(app) {
        this.app = app;
        this.selectedRegisters = [];
        this.selectedTreeItem = null;
        this.editingCell = null;
        this.initElements();
    }

    initElements() {
        // Cache DOM elements
        this.elements = {
            // Toolbar
            btnNewConnection: document.getElementById('btnNewConnection'),
            btnNewSlave: document.getElementById('btnNewSlave'),
            btnOpenConnection: document.getElementById('btnOpenConnection'),
            btnCloseConnection: document.getElementById('btnCloseConnection'),
            btnEditConnection: document.getElementById('btnEditConnection'),
            btnEditSlave: document.getElementById('btnEditSlave'),
            selectBaudRate: document.getElementById('selectBaudRate'),
            selectParity: document.getElementById('selectParity'),
            connectionStatus: document.getElementById('connectionStatus'),
            btnDarkMode: document.getElementById('btnDarkMode'),

            // Sidebar
            sidebar: document.getElementById('sidebar'),
            sidebarResizer: document.getElementById('sidebarResizer'),
            deviceTree: document.getElementById('deviceTree'),
            btnAddConnectionSidebar: document.getElementById('btnAddConnectionSidebar'),

            // Action bar
            btnTrafficLog: document.getElementById('btnTrafficLog'),
            btnAddRegisters: document.getElementById('btnAddRegisters'),
            btnRefreshRegisters: document.getElementById('btnRefreshRegisters'),
            btnResetRegisters: document.getElementById('btnResetRegisters'),
            btnAutoPoll: document.getElementById('btnAutoPoll'),
            btnAutoPollIcon: document.getElementById('btnAutoPollIcon'),
            btnAutoPollText: document.getElementById('btnAutoPollText'),
            functionTabs: document.getElementById('functionTabs'),

            // Register table (multi-column)
            registerTableContainer: document.getElementById('registerTableContainer'),
            registerTableEmpty: document.getElementById('registerTableEmpty'),
            registerColumns: document.getElementById('registerColumns'),
            btnToggleComments: document.getElementById('btnToggleComments'),
            btnToggleCommentsText: document.getElementById('btnToggleCommentsText'),

            // Value editor
            valueEditor: document.getElementById('valueEditor'),
            valueEditorToggle: document.getElementById('valueEditorToggle'),
            valueEditorResize: document.getElementById('valueEditorResize'),
            valueEditorContent: document.getElementById('valueEditorContent'),
            numericValues: document.getElementById('numericValues'),
            longValues: document.getElementById('longValues'),
            floatValues: document.getElementById('floatValues'),
            doubleValues: document.getElementById('doubleValues'),
            stringValues: document.getElementById('stringValues'),

            // Traffic log
            trafficLog: document.getElementById('trafficLog'),
            trafficLogContent: document.getElementById('trafficLogContent'),
            btnClearLog: document.getElementById('btnClearLog'),
            btnPauseLog: document.getElementById('btnPauseLog'),
            btnCopyLog: document.getElementById('btnCopyLog'),
            btnCloseLog: document.getElementById('btnCloseLog'),

            // Status bar
            statusConnection: document.getElementById('statusConnection'),
            statusSlave: document.getElementById('statusSlave'),
            statusLastPoll: document.getElementById('statusLastPoll'),
            statusErrors: document.getElementById('statusErrors'),
            statusMessages: document.getElementById('statusMessages'),

            // Modals
            modalNewConnection: document.getElementById('modalNewConnection'),
            modalNewSlave: document.getElementById('modalNewSlave'),
            modalNewGroup: document.getElementById('modalNewGroup'),
            modalAddRegister: document.getElementById('modalAddRegister'),
            modalEditSlave: document.getElementById('modalEditSlave'),
            modalEditGroup: document.getElementById('modalEditGroup'),
            modalEditConnection: document.getElementById('modalEditConnection'),

            // Context menu
            contextMenu: document.getElementById('contextMenu'),

            // Loading & notifications
            loadingOverlay: document.getElementById('loadingOverlay'),
            loadingText: document.getElementById('loadingText'),
            notificationContainer: document.getElementById('notificationContainer')
        };
    }

    // ===== Notifications =====
    showNotification(message, type = 'info', duration = 5000) {
        const container = this.elements.notificationContainer;
        const notification = document.createElement('div');
        notification.className = `notification notification--${type}`;

        const icons = {
            success: '✓',
            error: '✗',
            warning: '⚠',
            info: 'ℹ'
        };

        notification.innerHTML = `
            <span class="notification__icon">${icons[type] || icons.info}</span>
            <span class="notification__message">${message}</span>
            <button class="notification__close">&times;</button>
        `;

        const closeBtn = notification.querySelector('.notification__close');
        closeBtn.addEventListener('click', () => this.hideNotification(notification));

        container.appendChild(notification);

        if (duration > 0) {
            setTimeout(() => this.hideNotification(notification), duration);
        }

        return notification;
    }

    hideNotification(notification) {
        notification.classList.add('hiding');
        setTimeout(() => notification.remove(), 300);
    }

    // ===== Loading Overlay =====
    showLoading(message = 'Loading...') {
        this.elements.loadingText.textContent = message;
        this.elements.loadingOverlay.style.display = 'flex';
    }

    hideLoading() {
        this.elements.loadingOverlay.style.display = 'none';
    }

    // ===== Modal Management =====
    showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
            const firstInput = modal.querySelector('input, select');
            if (firstInput) firstInput.focus();
        }
    }

    hideModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
        }
    }

    hideAllModals() {
        document.querySelectorAll('.modal.active').forEach(modal => {
            modal.classList.remove('active');
        });
    }

    // ===== Context Menu =====
    showContextMenu(x, y, itemType, itemId) {
        const menu = this.elements.contextMenu;

        // Hide all items first
        menu.querySelectorAll('.context-menu__item').forEach(item => {
            item.style.display = 'none';
        });
        menu.querySelectorAll('.context-menu__divider').forEach(div => {
            div.style.display = 'none';
        });

        // Show relevant items based on type
        if (itemType === 'connection') {
            const conn = this.app.store.getConnection(itemId);
            if (conn) {
                if (conn.isConnected) {
                    menu.querySelector('[data-action="disconnect"]').style.display = '';
                } else {
                    menu.querySelector('[data-action="connect"]').style.display = '';
                }
                menu.querySelector('[data-action="remove"]').style.display = '';
            }
        } else if (itemType === 'slave') {
            menu.querySelector('[data-action="edit"]').style.display = '';
            menu.querySelector('[data-action="delete"]').style.display = '';
            menu.querySelectorAll('.context-menu__divider')[1].style.display = '';
            menu.querySelector('[data-action="newGroup"]').style.display = '';
        } else if (itemType === 'group') {
            menu.querySelector('[data-action="edit"]').style.display = '';
            menu.querySelector('[data-action="delete"]').style.display = '';
            menu.querySelectorAll('.context-menu__divider')[1].style.display = '';
            menu.querySelector('[data-action="addRegister"]').style.display = '';
            menu.querySelectorAll('.context-menu__divider')[2].style.display = '';
            menu.querySelector('[data-action="refresh"]').style.display = '';

            const group = this.app.store.getRegisterGroup(itemId);
            if (group && group.autoPolling) {
                menu.querySelector('[data-action="stopPolling"]').style.display = '';
            } else {
                menu.querySelector('[data-action="startPolling"]').style.display = '';
            }
        }

        // Position menu
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.style.display = 'block';
        menu.dataset.itemType = itemType;
        menu.dataset.itemId = itemId;

        // Adjust if off screen
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    }

    hideContextMenu() {
        this.elements.contextMenu.style.display = 'none';
    }

    // ===== Device Tree =====
    renderDeviceTree() {
        const tree = this.elements.deviceTree;

        if (this.app.store.connections.length === 0) {
            tree.innerHTML = `
                <div class="device-tree__empty">
                    <p>No connections configured.</p>
                    <p>Click "New Connection" to start.</p>
                </div>
            `;
            return;
        }

        let html = '';

        for (const conn of this.app.store.connections) {
            const statusClass = conn.isConnected ? 'connected' : 'disconnected';
            const slaves = this.app.store.getSlavesForConnection(conn.id);
            const hasChildren = slaves.length > 0;

            html += `
                <div class="tree-item" data-type="connection" data-id="${conn.id}">
                    <div class="tree-item__header">
                        <span class="tree-item__toggle ${hasChildren ? 'expanded' : ''}">${hasChildren ? '▶' : ''}</span>
                        <span class="tree-item__icon">📁</span>
                        <span class="tree-item__name">${conn.portName}</span>
                        <span class="tree-item__status tree-item__status--${statusClass}"></span>
                    </div>
                    <div class="tree-item__children ${hasChildren ? '' : 'collapsed'}">
            `;

            for (const slave of slaves) {
                const groups = this.app.store.getGroupsForSlave(slave.id);
                const hasGroupChildren = groups.length > 0;

                html += `
                    <div class="tree-item" data-type="slave" data-id="${slave.id}">
                        <div class="tree-item__header">
                            <span class="tree-item__toggle ${hasGroupChildren ? 'expanded' : ''}">${hasGroupChildren ? '▶' : ''}</span>
                            <span class="tree-item__icon">📟</span>
                            <span class="tree-item__name">${slave.alias} (ID: ${slave.slaveId})</span>
                        </div>
                        <div class="tree-item__children ${hasGroupChildren ? '' : 'collapsed'}">
                `;

                for (const group of groups) {
                    const pollingClass = group.autoPolling ? 'polling' : '';

                    html += `
                        <div class="tree-item" data-type="group" data-id="${group.id}">
                            <div class="tree-item__header">
                                <span class="tree-item__toggle"></span>
                                <span class="tree-item__icon">📋</span>
                                <span class="tree-item__name">${group.name}</span>
                                ${group.autoPolling ? '<span class="tree-item__status tree-item__status--polling"></span>' : ''}
                            </div>
                        </div>
                    `;
                }

                html += `
                        </div>
                    </div>
                `;
            }

            html += `
                    </div>
                </div>
            `;
        }

        tree.innerHTML = html;
        this.attachTreeEventListeners();
    }

    attachTreeEventListeners() {
        const tree = this.elements.deviceTree;

        // Toggle expand/collapse
        tree.querySelectorAll('.tree-item__toggle').forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = toggle.closest('.tree-item');
                const children = item.querySelector('.tree-item__children');
                if (children) {
                    children.classList.toggle('collapsed');
                    toggle.classList.toggle('expanded');
                }
            });
        });

        // Select item
        tree.querySelectorAll('.tree-item__header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Deselect all
                tree.querySelectorAll('.tree-item__header.selected').forEach(h => {
                    h.classList.remove('selected');
                });
                header.classList.add('selected');

                const item = header.closest('.tree-item');
                this.selectedTreeItem = {
                    type: item.dataset.type,
                    id: item.dataset.id
                };

                this.onTreeItemSelected(this.selectedTreeItem);
            });

            // Context menu
            header.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const item = header.closest('.tree-item');
                this.showContextMenu(e.pageX, e.pageY, item.dataset.type, item.dataset.id);
            });

            // Double click to expand/edit
            header.addEventListener('dblclick', () => {
                const item = header.closest('.tree-item');
                if (item.dataset.type === 'group') {
                    this.app.handleRefreshRegisters();
                }
            });
        });
    }

    onTreeItemSelected(item) {
        // Update toolbar buttons based on selection
        const { btnNewSlave, btnOpenConnection, btnCloseConnection, btnEditConnection, btnEditSlave,
                btnAddRegisters, btnRefreshRegisters, btnResetRegisters, btnAutoPoll, btnAutoPollIcon, btnAutoPollText, functionTabs } = this.elements;

        if (item.type === 'connection') {
            const conn = this.app.store.getConnection(item.id);
            btnNewSlave.disabled = !conn || !conn.isConnected;
            btnOpenConnection.disabled = !conn || conn.isConnected;
            btnCloseConnection.disabled = !conn || !conn.isConnected;
            btnEditConnection.disabled = false;
            btnEditSlave.disabled = true;
            btnAddRegisters.disabled = true;
            btnRefreshRegisters.disabled = true;
            btnResetRegisters.disabled = true;
            btnAutoPoll.disabled = true;
            functionTabs.style.display = 'none';

            // Show empty state
            this.showRegisterTableEmpty();

        } else if (item.type === 'slave') {
            const slave = this.app.store.getSlave(item.id);
            const conn = slave ? this.app.store.getConnection(slave.connectionId) : null;
            btnNewSlave.disabled = true;
            btnOpenConnection.disabled = true;
            btnCloseConnection.disabled = true;
            btnEditConnection.disabled = true;
            btnEditSlave.disabled = false;
            btnAddRegisters.disabled = true;
            btnRefreshRegisters.disabled = true;
            btnResetRegisters.disabled = true;
            btnAutoPoll.disabled = true;
            functionTabs.style.display = 'none';

            // Show helpful message for slave selection
            const groups = this.app.store.getGroupsForSlave(item.id);
            if (groups.length > 0) {
                this.elements.registerTableEmpty.innerHTML = `
                    <div class="register-table__empty-icon">📟</div>
                    <h3>Slave Selected</h3>
                    <p>Click on a <strong>Register Group</strong> below this slave to view registers.</p>
                    <p style="margin-top: 10px; color: var(--text-secondary);">Or right-click the slave to add a new group.</p>
                `;
            } else {
                this.elements.registerTableEmpty.innerHTML = `
                    <div class="register-table__empty-icon">📟</div>
                    <h3>No Register Groups</h3>
                    <p>Right-click this slave and select <strong>"New Group"</strong> to create a register group.</p>
                `;
            }
            this.showRegisterTableEmpty();

        } else if (item.type === 'group') {
            const group = this.app.store.getRegisterGroup(item.id);
            const isPolling = group && group.autoPolling;
            btnNewSlave.disabled = true;
            btnOpenConnection.disabled = true;
            btnCloseConnection.disabled = true;
            btnEditConnection.disabled = true;
            btnEditSlave.disabled = true;
            btnAddRegisters.disabled = false;
            btnRefreshRegisters.disabled = false;
            btnResetRegisters.disabled = false;
            btnAutoPoll.disabled = false;
            // Update Auto-Poll button text/icon based on polling state
            btnAutoPollIcon.textContent = isPolling ? '⏹️' : '▶️';
            btnAutoPollText.textContent = isPolling ? 'Stop Poll' : 'Auto-Poll';
            functionTabs.style.display = 'flex';

            this.renderRegisterTable(item.id);
        }

        this.updateStatusBar();
    }

    // ===== Register Table (Multi-Column) =====
    showRegisterTableEmpty() {
        this.elements.registerTableEmpty.style.display = 'flex';
        this.elements.registerColumns.style.display = 'none';
    }

    renderRegisterTable(groupId) {
        const registers = this.app.store.getRegistersForGroup(groupId);
        const ROWS_PER_COLUMN = 10;

        if (registers.length === 0) {
            this.elements.registerTableEmpty.innerHTML = `
                <div class="register-table__empty-icon">📋</div>
                <h3>No Registers in This Group</h3>
                <p>Right-click the group and select "Add Register" to add registers.</p>
            `;
            this.showRegisterTableEmpty();
            return;
        }

        this.elements.registerTableEmpty.style.display = 'none';
        this.elements.registerColumns.style.display = 'flex';

        // Preserve comments visibility state
        const hideComments = this.elements.registerColumns.classList.contains('hide-comments');

        const container = this.elements.registerColumns;
        container.innerHTML = '';
        if (hideComments) container.classList.add('hide-comments');

        // Split registers into columns of ROWS_PER_COLUMN each
        const numColumns = Math.ceil(registers.length / ROWS_PER_COLUMN);

        for (let col = 0; col < numColumns; col++) {
            const startIdx = col * ROWS_PER_COLUMN;
            const columnRegs = registers.slice(startIdx, startIdx + ROWS_PER_COLUMN);

            const columnDiv = document.createElement('div');
            columnDiv.className = 'register-column';

            const table = document.createElement('table');
            table.className = 'register-table';

            // Header
            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr>
                    <th class="register-table__th register-table__th--type">Type</th>
                    <th class="register-table__th register-table__th--address">Addr</th>
                    <th class="register-table__th register-table__th--alias">Alias</th>
                    <th class="register-table__th register-table__th--value">Value</th>
                    <th class="register-table__th register-table__th--comment">Comment</th>
                </tr>
            `;
            table.appendChild(thead);

            // Body
            const tbody = document.createElement('tbody');
            for (const reg of columnRegs) {
                const typeInfo = REGISTER_TYPES[reg.type];
                const isWritable = typeInfo && typeInfo.writeFC !== null;
                const rowClass = isWritable ? '' : 'register-table__row--readonly';

                const tr = document.createElement('tr');
                tr.className = `register-table__row ${rowClass}`;
                tr.dataset.registerId = reg.id;
                tr.dataset.registerType = reg.type;

                tr.innerHTML = `
                    <td class="register-table__cell register-table__cell--type">${reg.type}</td>
                    <td class="register-table__cell register-table__cell--address">${ValueInterpreter.toHexString(reg.address)}</td>
                    <td class="register-table__cell register-table__cell--alias">${reg.alias || '-'}</td>
                    <td class="register-table__cell register-table__cell--value ${isWritable ? 'editable' : ''}">${reg.value}</td>
                    <td class="register-table__cell register-table__cell--comment">${reg.comment || ''}</td>
                `;

                // Row selection with Ctrl+click and Shift+click support
                tr.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT') return;

                    const allRows = Array.from(container.querySelectorAll('tr[data-register-id]'));

                    if (e.ctrlKey) {
                        // Toggle selection
                        tr.classList.toggle('selected');
                        if (tr.classList.contains('selected')) {
                            this.selectedRegisters.push(reg.id);
                        } else {
                            this.selectedRegisters = this.selectedRegisters.filter(id => id !== reg.id);
                        }
                    } else if (e.shiftKey && this.selectedRegisters.length > 0) {
                        // Range selection
                        const lastSelectedRow = container.querySelector(`tr[data-register-id="${this.selectedRegisters[this.selectedRegisters.length - 1]}"]`);
                        const startIdx = allRows.indexOf(lastSelectedRow);
                        const endIdx = allRows.indexOf(tr);
                        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

                        for (let i = from; i <= to; i++) {
                            allRows[i].classList.add('selected');
                            const regId = allRows[i].dataset.registerId;
                            if (!this.selectedRegisters.includes(regId)) {
                                this.selectedRegisters.push(regId);
                            }
                        }
                    } else {
                        // Single selection - clear all and select this one
                        container.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
                        tr.classList.add('selected');
                        this.selectedRegisters = [reg.id];
                    }

                    this.updateValueEditor();
                });

                // Double click to edit (if writable)
                if (isWritable) {
                    const valueCell = tr.querySelector('.register-table__cell--value');
                    valueCell.addEventListener('dblclick', () => {
                        this.startCellEdit(valueCell, reg);
                    });
                }

                tbody.appendChild(tr);
            }

            table.appendChild(tbody);
            columnDiv.appendChild(table);
            container.appendChild(columnDiv);
        }
    }

    startCellEdit(cell, register) {
        if (this.editingCell) return;

        this.editingCell = cell;
        const currentValue = register.value;

        cell.innerHTML = `<input type="number" class="register-table__input" value="${currentValue}">`;
        const input = cell.querySelector('input');
        input.focus();
        input.select();

        const finishEdit = async (save) => {
            if (!this.editingCell) return;

            if (save) {
                const newValue = parseInt(input.value) || 0;
                if (newValue !== currentValue) {
                    try {
                        await this.app.writeRegister(register, newValue);
                        cell.parentElement.classList.add('register-table__row--success');
                        setTimeout(() => {
                            cell.parentElement.classList.remove('register-table__row--success');
                        }, 1000);
                    } catch (error) {
                        cell.parentElement.classList.add('register-table__row--error');
                        this.showNotification(error.message, 'error');
                        setTimeout(() => {
                            cell.parentElement.classList.remove('register-table__row--error');
                        }, 3000);
                    }
                }
            }

            cell.textContent = register.value;
            this.editingCell = null;
        };

        input.addEventListener('blur', () => finishEdit(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                finishEdit(true);
            } else if (e.key === 'Escape') {
                finishEdit(false);
            }
        });
    }

    updateRegisterValue(registerId, value) {
        const row = this.elements.registerColumns.querySelector(`tr[data-register-id="${registerId}"]`);
        if (row && !this.editingCell) {
            const valueCell = row.querySelector('.register-table__cell--value');
            if (valueCell && valueCell.textContent != value) {
                valueCell.textContent = value;
                row.classList.add('register-table__row--success');
                setTimeout(() => row.classList.remove('register-table__row--success'), 500);
            }
        }
    }

    handleToggleComments() {
        const container = this.elements.registerColumns;
        container.classList.toggle('hide-comments');
        const isHidden = container.classList.contains('hide-comments');
        this.elements.btnToggleCommentsText.textContent = isHidden ? 'Show Comments' : 'Hide Comments';
    }

    // ===== Value Editor =====
    updateValueEditor() {
        // Clear all value containers
        this.elements.numericValues.innerHTML = '';
        this.elements.longValues.innerHTML = '';
        this.elements.floatValues.innerHTML = '';
        this.elements.doubleValues.innerHTML = '';
        this.elements.stringValues.innerHTML = '';

        const panels = this.elements.valueEditorContent.querySelectorAll('.value-editor__panel');

        if (this.selectedRegisters.length === 0) {
            panels.forEach(panel => {
                panel.querySelector('.value-editor__info').style.display = '';
            });
            return;
        }

        const registers = this.selectedRegisters
            .map(id => this.app.store.getRegister(id))
            .filter(r => r)
            .sort((a, b) => a.address - b.address);

        // Numeric tab - show each register as a card
        const numericPanel = this.elements.valueEditorContent.querySelector('[data-panel="numeric"]');
        if (registers.length > 0) {
            numericPanel.querySelector('.value-editor__info').style.display = 'none';
            for (const reg of registers) {
                const card = document.createElement('div');
                card.className = 'value-editor__card';
                card.innerHTML = `
                    <div class="value-editor__card-header">${reg.type} @ ${ValueInterpreter.toHexString(reg.address)}</div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">Unsigned:</span><span class="value-editor__card-value">${ValueInterpreter.toUnsigned16(reg.value)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">Signed:</span><span class="value-editor__card-value">${ValueInterpreter.toSigned16(reg.value)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">Hex:</span><span class="value-editor__card-value">${ValueInterpreter.toHexString(reg.value)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">Binary:</span><span class="value-editor__card-value">${ValueInterpreter.toBinaryString(reg.value)}</span></div>
                `;
                this.elements.numericValues.appendChild(card);
            }
        } else {
            numericPanel.querySelector('.value-editor__info').style.display = '';
        }

        // Long tab - show pairs of consecutive registers as 32-bit long
        const longPanel = this.elements.valueEditorContent.querySelector('[data-panel="long"]');
        const longPairs = this.getConsecutivePairs(registers, 2);
        if (longPairs.length > 0) {
            longPanel.querySelector('.value-editor__info').style.display = 'none';
            for (const pair of longPairs) {
                const card = document.createElement('div');
                card.className = 'value-editor__card';
                card.innerHTML = `
                    <div class="value-editor__card-header">${ValueInterpreter.toHexString(pair[0].address)} - ${ValueInterpreter.toHexString(pair[1].address)}</div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">AB CD:</span><span class="value-editor__card-value">${ValueInterpreter.toLong32(pair[0].value, pair[1].value, 'ABCD')}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">CD AB:</span><span class="value-editor__card-value">${ValueInterpreter.toLong32(pair[0].value, pair[1].value, 'CDAB')}</span></div>
                `;
                this.elements.longValues.appendChild(card);
            }
        } else {
            longPanel.querySelector('.value-editor__info').style.display = '';
        }

        // Float tab - show pairs of consecutive registers as 32-bit float
        const floatPanel = this.elements.valueEditorContent.querySelector('[data-panel="float"]');
        const floatPairs = this.getConsecutivePairs(registers, 2);
        if (floatPairs.length > 0) {
            floatPanel.querySelector('.value-editor__info').style.display = 'none';
            for (const pair of floatPairs) {
                const card = document.createElement('div');
                card.className = 'value-editor__card';
                card.innerHTML = `
                    <div class="value-editor__card-header">${ValueInterpreter.toHexString(pair[0].address)} - ${ValueInterpreter.toHexString(pair[1].address)}</div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">AB CD:</span><span class="value-editor__card-value">${ValueInterpreter.toFloat32(pair[0].value, pair[1].value, 'ABCD').toFixed(6)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">CD AB:</span><span class="value-editor__card-value">${ValueInterpreter.toFloat32(pair[0].value, pair[1].value, 'CDAB').toFixed(6)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">BA DC:</span><span class="value-editor__card-value">${ValueInterpreter.toFloat32(pair[0].value, pair[1].value, 'BADC').toFixed(6)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">DC BA:</span><span class="value-editor__card-value">${ValueInterpreter.toFloat32(pair[0].value, pair[1].value, 'DCBA').toFixed(6)}</span></div>
                `;
                this.elements.floatValues.appendChild(card);
            }
        } else {
            floatPanel.querySelector('.value-editor__info').style.display = '';
        }

        // Double tab - show groups of 4 consecutive registers as 64-bit double
        const doublePanel = this.elements.valueEditorContent.querySelector('[data-panel="double"]');
        const doubleGroups = this.getConsecutivePairs(registers, 4);
        if (doubleGroups.length > 0) {
            doublePanel.querySelector('.value-editor__info').style.display = 'none';
            for (const group of doubleGroups) {
                const card = document.createElement('div');
                card.className = 'value-editor__card';
                card.innerHTML = `
                    <div class="value-editor__card-header">${ValueInterpreter.toHexString(group[0].address)} - ${ValueInterpreter.toHexString(group[3].address)}</div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">Big-endian:</span><span class="value-editor__card-value">${ValueInterpreter.toFloat64(group[0].value, group[1].value, group[2].value, group[3].value, true).toFixed(10)}</span></div>
                    <div class="value-editor__card-row"><span class="value-editor__card-label">Little-endian:</span><span class="value-editor__card-value">${ValueInterpreter.toFloat64(group[0].value, group[1].value, group[2].value, group[3].value, false).toFixed(10)}</span></div>
                `;
                this.elements.doubleValues.appendChild(card);
            }
        } else {
            doublePanel.querySelector('.value-editor__info').style.display = '';
        }

        // String tab - show all selected registers as ASCII
        const stringPanel = this.elements.valueEditorContent.querySelector('[data-panel="string"]');
        if (registers.length > 0) {
            stringPanel.querySelector('.value-editor__info').style.display = 'none';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'value-editor__string-input';
            input.value = ValueInterpreter.toString(registers.map(r => r.value));
            input.readOnly = true;
            this.elements.stringValues.appendChild(input);
        } else {
            stringPanel.querySelector('.value-editor__info').style.display = '';
        }
    }

    // Get groups of N consecutive registers
    getConsecutivePairs(registers, size) {
        const groups = [];
        for (let i = 0; i <= registers.length - size; i++) {
            let isConsecutive = true;
            for (let j = 1; j < size; j++) {
                if (registers[i + j].address !== registers[i + j - 1].address + 1) {
                    isConsecutive = false;
                    break;
                }
            }
            if (isConsecutive) {
                groups.push(registers.slice(i, i + size));
                i += size - 1; // Skip to next group
            }
        }
        return groups;
    }

    areConsecutive(registers) {
        for (let i = 1; i < registers.length; i++) {
            if (registers[i].address !== registers[i-1].address + 1) {
                return false;
            }
        }
        return true;
    }

    // ===== Traffic Log =====
    updateTrafficLog(entry) {
        const content = this.elements.trafficLogContent;

        // Remove empty message if exists
        const emptyMsg = content.querySelector('.traffic-log__empty');
        if (emptyMsg) emptyMsg.remove();

        const div = document.createElement('div');
        div.className = `traffic-log__entry traffic-log__entry--${entry.direction.toLowerCase()}`;
        div.textContent = `[${entry.timestamp}] ${entry.direction}: ${entry.hexString}`;

        content.appendChild(div);
        content.scrollTop = content.scrollHeight;
    }

    clearTrafficLog() {
        this.elements.trafficLogContent.innerHTML = '<div class="traffic-log__empty">No traffic logged yet.</div>';
    }

    // ===== Status Bar =====
    updateStatusBar() {
        const { statusConnection, statusSlave, statusLastPoll, statusErrors, statusMessages } = this.elements;

        // Connection status
        let connText = 'Disconnected';
        if (this.selectedTreeItem) {
            let conn = null;
            if (this.selectedTreeItem.type === 'connection') {
                conn = this.app.store.getConnection(this.selectedTreeItem.id);
            } else if (this.selectedTreeItem.type === 'slave') {
                const slave = this.app.store.getSlave(this.selectedTreeItem.id);
                conn = slave ? this.app.store.getConnection(slave.connectionId) : null;
            } else if (this.selectedTreeItem.type === 'group') {
                const group = this.app.store.getRegisterGroup(this.selectedTreeItem.id);
                const slave = group ? this.app.store.getSlave(group.slaveId) : null;
                conn = slave ? this.app.store.getConnection(slave.connectionId) : null;
            }

            if (conn && conn.isConnected) {
                connText = `${conn.portName} (${conn.baudRate} ${conn.dataBits}${conn.parity.charAt(0).toUpperCase()}${conn.stopBits})`;
            }
        }
        statusConnection.textContent = connText;

        // Slave info
        let slaveText = '-';
        if (this.selectedTreeItem) {
            let slave = null;
            if (this.selectedTreeItem.type === 'slave') {
                slave = this.app.store.getSlave(this.selectedTreeItem.id);
            } else if (this.selectedTreeItem.type === 'group') {
                const group = this.app.store.getRegisterGroup(this.selectedTreeItem.id);
                slave = group ? this.app.store.getSlave(group.slaveId) : null;
            }
            if (slave) {
                slaveText = `${slave.alias} (ID: ${slave.slaveId})`;
            }
        }
        statusSlave.textContent = slaveText;

        statusErrors.textContent = this.app.errorCount;
        statusMessages.textContent = this.app.messageCount;
    }

    updateLastPoll() {
        this.elements.statusLastPoll.textContent = 'Just now';
    }

    // ===== Connection Status =====
    updateConnectionStatus(connected, portName = '') {
        const status = this.elements.connectionStatus;
        status.classList.remove('connection-status--connected', 'connection-status--disconnected');

        if (connected) {
            status.classList.add('connection-status--connected');
            status.querySelector('.connection-status__text').textContent = `Connected to ${portName}`;
        } else {
            status.classList.add('connection-status--disconnected');
            status.querySelector('.connection-status__text').textContent = 'Disconnected';
        }
    }
}

// ============================================
// Main Application
// ============================================
class ModbusEmulator {
    constructor() {
        this.store = new Store();
        this.serialManager = new SerialManager();
        this.trafficLogger = new TrafficLogger();
        this.ui = null;
        this.currentConnection = null;
        this.currentSlave = null;
        this.errorCount = 0;
        this.messageCount = 0;

        this.init();
    }

    async init() {
        // Check browser support
        if (!SerialManager.isSupported()) {
            document.getElementById('browser-warning').style.display = 'flex';
        }

        // Load saved data
        this.store.loadFromLocalStorage();

        // Initialize UI
        this.ui = new UIManager(this);

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.ui.renderDeviceTree();

        // Set up traffic logger callback
        this.trafficLogger.onUpdate = (entry) => {
            this.ui.updateTrafficLog(entry);
        };

        // Handle page unload
        window.addEventListener('beforeunload', () => {
            this.store.saveToLocalStorage();
        });

        console.log('Modbus RTU Master Emulator initialized');
    }

    setupEventListeners() {
        const { elements } = this.ui;

        // Toolbar buttons
        elements.btnNewConnection.addEventListener('click', () => this.handleNewConnection());
        elements.btnNewSlave.addEventListener('click', () => this.handleNewSlave());
        elements.btnOpenConnection.addEventListener('click', () => this.handleOpenConnection());
        elements.btnCloseConnection.addEventListener('click', () => this.handleCloseConnection());
        elements.btnEditConnection.addEventListener('click', () => this.handleEditConnection());
        elements.btnEditSlave.addEventListener('click', () => this.handleEditSlave());
        elements.btnAddConnectionSidebar.addEventListener('click', () => this.handleNewConnection());

        // Action bar
        elements.btnTrafficLog.addEventListener('click', () => this.toggleTrafficLog());
        elements.btnAddRegisters.addEventListener('click', () => this.handleAddRegistersButton());
        elements.btnRefreshRegisters.addEventListener('click', () => this.handleRefreshRegisters());
        elements.btnResetRegisters.addEventListener('click', () => this.handleResetRegisters());
        elements.btnAutoPoll.addEventListener('click', () => this.handleToggleAutoPoll());
        elements.btnToggleComments.addEventListener('click', () => this.ui.handleToggleComments());

        // Traffic log
        elements.btnClearLog.addEventListener('click', () => {
            this.trafficLogger.clear();
            this.ui.clearTrafficLog();
        });
        elements.btnPauseLog.addEventListener('click', () => {
            if (this.trafficLogger.isPaused) {
                this.trafficLogger.resume();
                elements.btnPauseLog.textContent = 'Pause';
            } else {
                this.trafficLogger.pause();
                elements.btnPauseLog.textContent = 'Resume';
            }
        });
        elements.btnCopyLog.addEventListener('click', () => {
            navigator.clipboard.writeText(this.trafficLogger.export());
            this.ui.showNotification('Traffic log copied to clipboard', 'success');
        });
        elements.btnCloseLog.addEventListener('click', () => this.toggleTrafficLog());

        // Value editor tabs
        elements.valueEditor.querySelectorAll('.value-editor__tab').forEach(tab => {
            tab.addEventListener('click', () => {
                elements.valueEditor.querySelectorAll('.value-editor__tab').forEach(t => t.classList.remove('value-editor__tab--active'));
                elements.valueEditor.querySelectorAll('.value-editor__panel').forEach(p => p.classList.remove('value-editor__panel--active'));

                tab.classList.add('value-editor__tab--active');
                const panelName = tab.dataset.tab;
                elements.valueEditor.querySelector(`[data-panel="${panelName}"]`).classList.add('value-editor__panel--active');
            });
        });

        // Value editor toggle
        elements.valueEditorToggle.addEventListener('click', () => {
            elements.valueEditor.classList.toggle('collapsed');
        });

        // Value editor resize
        let isResizingEditor = false;
        let editorStartY = 0;
        let editorStartHeight = 0;

        elements.valueEditorResize.addEventListener('mousedown', (e) => {
            isResizingEditor = true;
            editorStartY = e.clientY;
            editorStartHeight = elements.valueEditor.offsetHeight;
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingEditor) return;
            const deltaY = editorStartY - e.clientY;
            const newHeight = Math.max(100, Math.min(window.innerHeight * 0.6, editorStartHeight + deltaY));
            elements.valueEditor.style.height = newHeight + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizingEditor) {
                isResizingEditor = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });

        // Dark mode toggle
        elements.btnDarkMode.addEventListener('click', () => {
            document.body.dataset.theme = document.body.dataset.theme === 'dark' ? '' : 'dark';
            elements.btnDarkMode.querySelector('span').textContent = document.body.dataset.theme === 'dark' ? '☀️' : '🌙';
        });

        // Sidebar resizer
        let isResizing = false;
        elements.sidebarResizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            elements.sidebarResizer.classList.add('active');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = e.clientX;
            if (newWidth >= 200 && newWidth <= 500) {
                elements.sidebar.style.width = `${newWidth}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            isResizing = false;
            elements.sidebarResizer.classList.remove('active');
        });

        // Modal close buttons
        document.querySelectorAll('[data-modal-close]').forEach(btn => {
            btn.addEventListener('click', () => this.ui.hideAllModals());
        });

        // Modal overlay clicks
        document.querySelectorAll('.modal__overlay').forEach(overlay => {
            overlay.addEventListener('click', () => this.ui.hideAllModals());
        });

        // Context menu actions
        elements.contextMenu.querySelectorAll('.context-menu__item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                const itemType = elements.contextMenu.dataset.itemType;
                const itemId = elements.contextMenu.dataset.itemId;
                this.handleContextMenuAction(action, itemType, itemId);
                this.ui.hideContextMenu();
            });
        });

        // Hide context menu on click outside
        document.addEventListener('click', (e) => {
            if (!elements.contextMenu.contains(e.target)) {
                this.ui.hideContextMenu();
            }
        });

        // Modal form submissions
        document.getElementById('btnSelectPort').addEventListener('click', () => this.handleSelectPort());
        document.getElementById('btnAddSlave').addEventListener('click', () => this.handleAddSlave());
        document.getElementById('btnAddGroup').addEventListener('click', () => this.handleAddGroup());
        document.getElementById('btnAddRegister').addEventListener('click', () => this.handleAddRegister());
        document.getElementById('btnUpdateSlave').addEventListener('click', () => this.handleUpdateSlave());
        document.getElementById('btnUpdateGroup').addEventListener('click', () => this.handleUpdateGroup());
        document.getElementById('btnUpdateConnection').addEventListener('click', () => this.handleUpdateConnection());

        // Function tabs
        elements.functionTabs.querySelectorAll('.function-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const fc = tab.dataset.fc;
                if (fc === 'TC') {
                    this.handleTestConnection();
                }
            });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Skip if typing in an input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                if (e.key === 'Escape') {
                    e.target.blur();
                }
                return;
            }

            if (e.ctrlKey || e.metaKey) {
                const key = e.key.toLowerCase();
                // Prevent browser defaults for our shortcuts
                if (['n', 'o', 'r', 't'].includes(key)) {
                    e.preventDefault();
                    e.stopPropagation();
                }

                switch (key) {
                    case 'n':
                        this.handleNewConnection();
                        break;
                    case 'o':
                        if (!elements.btnOpenConnection.disabled) {
                            this.handleOpenConnection();
                        }
                        break;
                    case 'r':
                        if (!elements.btnRefreshRegisters.disabled) {
                            this.handleRefreshRegisters();
                        }
                        break;
                    case 't':
                        this.handleTestConnection();
                        break;
                }
            }
            if (e.key === 'Escape') {
                this.ui.hideAllModals();
                this.ui.hideContextMenu();
            }
        });
    }

    // ===== Connection Handlers =====
    handleNewConnection() {
        this.ui.showModal('modalNewConnection');
    }

    async handleSelectPort() {
        try {
            this.ui.showLoading('Selecting port...');
            await this.serialManager.requestPort();

            const config = {
                portName: this.serialManager.getPortName(),
                baudRate: parseInt(document.getElementById('modalBaudRate').value),
                parity: document.getElementById('modalParity').value,
                dataBits: parseInt(document.getElementById('modalDataBits').value),
                stopBits: parseInt(document.getElementById('modalStopBits').value)
            };

            const connection = this.store.addConnection(config);
            this.currentConnection = connection;

            // Connect immediately
            await this.serialManager.connect(
                config.baudRate,
                config.parity,
                config.dataBits,
                config.stopBits
            );

            connection.isConnected = true;

            // Auto-create default Slave (ID: 1), Register Group, and 10 registers
            const slave = this.store.addSlave(connection.id, 1, 'Device 1');
            const group = this.store.addRegisterGroup(slave.id, 'Registers', 1000);

            // Add 10 holding registers (4x, address 0-9)
            const defaultRegisters = [];
            for (let i = 0; i < 10; i++) {
                defaultRegisters.push({ type: '4x', address: i, alias: '' });
            }
            this.store.addRegisters(group.id, defaultRegisters);

            this.ui.hideModal('modalNewConnection');
            this.ui.renderDeviceTree();
            this.ui.updateConnectionStatus(true, config.portName);

            // Select the new group so user can see the registers
            this.ui.selectedTreeItem = { type: 'group', id: group.id };
            this.ui.onTreeItemSelected(this.ui.selectedTreeItem);

            this.ui.showNotification(`Connected to ${config.portName}`, 'success');

        } catch (error) {
            this.handleSerialError(error);
        } finally {
            this.ui.hideLoading();
        }
    }

    async handleOpenConnection() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'connection') return;

        const conn = this.store.getConnection(this.ui.selectedTreeItem.id);
        if (!conn || conn.isConnected) return;

        try {
            this.ui.showLoading('Connecting...');

            // Request port again since we can't persist the port object
            await this.serialManager.requestPort();
            await this.serialManager.connect(conn.baudRate, conn.parity, conn.dataBits, conn.stopBits);

            conn.isConnected = true;
            conn.portName = this.serialManager.getPortName();
            this.currentConnection = conn;

            this.ui.renderDeviceTree();
            this.ui.updateConnectionStatus(true, conn.portName);
            this.ui.onTreeItemSelected(this.ui.selectedTreeItem);
            this.ui.showNotification(`Connected to ${conn.portName}`, 'success');

        } catch (error) {
            this.handleSerialError(error);
        } finally {
            this.ui.hideLoading();
        }
    }

    async handleCloseConnection() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'connection') return;

        const conn = this.store.getConnection(this.ui.selectedTreeItem.id);
        if (!conn || !conn.isConnected) return;

        try {
            // Stop all polling for this connection
            const slaves = this.store.getSlavesForConnection(conn.id);
            for (const slave of slaves) {
                const groups = this.store.getGroupsForSlave(slave.id);
                for (const group of groups) {
                    this.store.stopPolling(group.id);
                }
            }

            await this.serialManager.disconnect();
            conn.isConnected = false;
            this.currentConnection = null;

            this.ui.renderDeviceTree();
            this.ui.updateConnectionStatus(false);
            this.ui.onTreeItemSelected(this.ui.selectedTreeItem);
            this.ui.showNotification('Disconnected', 'info');

        } catch (error) {
            this.ui.showNotification(`Disconnect error: ${error.message}`, 'error');
        }
    }

    handleEditConnection() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'connection') return;

        const conn = this.store.getConnection(this.ui.selectedTreeItem.id);
        if (!conn) return;

        // Populate modal with current values
        document.getElementById('modalEditConnPort').value = conn.portName || 'Not selected';
        document.getElementById('modalEditConnBaudRate').value = conn.baudRate;
        document.getElementById('modalEditConnParity').value = conn.parity;
        document.getElementById('modalEditConnDataBits').value = conn.dataBits;
        document.getElementById('modalEditConnStopBits').value = conn.stopBits;

        this.pendingEditConnectionId = conn.id;
        this.ui.showModal('modalEditConnection');
    }

    handleUpdateConnection() {
        if (!this.pendingEditConnectionId) return;

        const conn = this.store.getConnection(this.pendingEditConnectionId);
        if (!conn) return;

        const newSettings = {
            baudRate: parseInt(document.getElementById('modalEditConnBaudRate').value),
            parity: document.getElementById('modalEditConnParity').value,
            dataBits: parseInt(document.getElementById('modalEditConnDataBits').value),
            stopBits: parseInt(document.getElementById('modalEditConnStopBits').value)
        };

        // Update connection in store
        Object.assign(conn, newSettings);
        this.store.saveToLocalStorage();

        this.ui.hideModal('modalEditConnection');
        this.ui.renderDeviceTree();
        this.ui.updateStatusBar();

        // If currently connected, notify that changes will apply on reconnect
        if (conn.isConnected) {
            this.ui.showNotification('Settings saved. Reconnect to apply changes.', 'info');
        } else {
            this.ui.showNotification('Connection settings updated', 'success');
        }
    }

    handleSerialError(error) {
        let message = error.message;

        if (error.name === 'NotFoundError') {
            message = 'No port selected';
        } else if (error.name === 'SecurityError') {
            message = 'Access denied - check browser permissions';
        } else if (error.name === 'NetworkError') {
            message = 'Device disconnected or in use by another application';
        }

        this.ui.showNotification(message, 'error');
        this.errorCount++;
        this.ui.updateStatusBar();
    }

    // ===== Slave Handlers =====
    handleNewSlave() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'connection') return;
        document.getElementById('modalSlaveId').value = '1';
        document.getElementById('modalSlaveAlias').value = '';
        this.ui.showModal('modalNewSlave');
    }

    handleAddSlave() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'connection') return;

        const slaveId = parseInt(document.getElementById('modalSlaveId').value);
        const alias = document.getElementById('modalSlaveAlias').value;

        if (slaveId < 1 || slaveId > 247) {
            this.ui.showNotification('Slave ID must be between 1 and 247', 'error');
            return;
        }

        this.store.addSlave(this.ui.selectedTreeItem.id, slaveId, alias);
        this.ui.hideModal('modalNewSlave');
        this.ui.renderDeviceTree();
        this.ui.showNotification(`Slave ${alias || slaveId} added`, 'success');
    }

    handleEditSlave() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'slave') return;

        const slave = this.store.getSlave(this.ui.selectedTreeItem.id);
        if (!slave) return;

        document.getElementById('modalEditSlaveId').value = slave.slaveId;
        document.getElementById('modalEditSlaveAlias').value = slave.alias;
        this.ui.showModal('modalEditSlave');
    }

    handleUpdateSlave() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'slave') return;

        const slaveId = parseInt(document.getElementById('modalEditSlaveId').value);
        const alias = document.getElementById('modalEditSlaveAlias').value;

        if (slaveId < 1 || slaveId > 247) {
            this.ui.showNotification('Slave ID must be between 1 and 247', 'error');
            return;
        }

        this.store.updateSlave(this.ui.selectedTreeItem.id, { slaveId, alias });
        this.ui.hideModal('modalEditSlave');
        this.ui.renderDeviceTree();
        this.ui.showNotification('Slave updated', 'success');
    }

    // ===== Register Group Handlers =====
    handleAddGroupFromContext(slaveId) {
        document.getElementById('modalGroupName').value = '';
        document.getElementById('modalPollingInterval').value = '1000';
        document.getElementById('modalGroupRegType').value = '4x';
        document.getElementById('modalGroupRegAddress').value = '40001';
        document.getElementById('modalGroupRegQuantity').value = '10';
        this.pendingGroupSlaveId = slaveId;
        this.ui.showModal('modalNewGroup');
    }

    handleAddGroup() {
        const name = document.getElementById('modalGroupName').value;
        const pollingInterval = parseInt(document.getElementById('modalPollingInterval').value) || 1000;

        if (!name) {
            this.ui.showNotification('Please enter a group name', 'error');
            return;
        }

        // Create the group
        const group = this.store.addRegisterGroup(this.pendingGroupSlaveId, name, pollingInterval);

        // Add registers if quantity > 0
        const regType = document.getElementById('modalGroupRegType').value;
        const regAddressStr = document.getElementById('modalGroupRegAddress').value;
        const regQuantity = parseInt(document.getElementById('modalGroupRegQuantity').value) || 0;

        if (regQuantity > 0 && regAddressStr) {
            // Parse address (supports hex like 0x0000 or decimal like 40001)
            let address;
            if (regAddressStr.startsWith('0x') || regAddressStr.startsWith('0X')) {
                address = parseInt(regAddressStr, 16);
            } else {
                address = ModbusMaster.convertAddress(regAddressStr, regType);
            }

            if (!isNaN(address)) {
                const configs = [];
                for (let i = 0; i < regQuantity; i++) {
                    configs.push({
                        type: regType,
                        address: address + i,
                        alias: ''
                    });
                }
                this.store.addRegisters(group.id, configs);
            }
        }

        this.ui.hideModal('modalNewGroup');
        this.ui.renderDeviceTree();

        // Select the new group
        this.ui.selectedTreeItem = { type: 'group', id: group.id };
        this.ui.onTreeItemSelected(this.ui.selectedTreeItem);

        const regMsg = regQuantity > 0 ? ` with ${regQuantity} registers` : '';
        this.ui.showNotification(`Register group "${name}" created${regMsg}`, 'success');
    }

    handleEditGroupFromContext(groupId) {
        const group = this.store.getRegisterGroup(groupId);
        if (!group) return;

        document.getElementById('modalEditGroupName').value = group.name;
        document.getElementById('modalEditPollingInterval').value = group.pollingInterval;
        this.pendingEditGroupId = groupId;
        this.ui.showModal('modalEditGroup');
    }

    handleUpdateGroup() {
        const name = document.getElementById('modalEditGroupName').value;
        const pollingInterval = parseInt(document.getElementById('modalEditPollingInterval').value) || 1000;

        if (!name) {
            this.ui.showNotification('Please enter a group name', 'error');
            return;
        }

        this.store.updateRegisterGroup(this.pendingEditGroupId, { name, pollingInterval });
        this.ui.hideModal('modalEditGroup');
        this.ui.renderDeviceTree();
        this.ui.showNotification('Group updated', 'success');
    }

    // ===== Register Handlers =====
    handleAddRegisterFromContext(groupId) {
        document.getElementById('modalRegisterType').value = '4x';
        document.getElementById('modalRegisterAddress').value = '';
        document.getElementById('modalRegisterAlias').value = '';
        document.getElementById('modalRegisterQuantity').value = '1';
        document.getElementById('modalRegisterComment').value = '';
        this.pendingRegisterGroupId = groupId;
        this.ui.showModal('modalAddRegister');
    }

    handleAddRegister() {
        const type = document.getElementById('modalRegisterType').value;
        const addressStr = document.getElementById('modalRegisterAddress').value;
        const alias = document.getElementById('modalRegisterAlias').value;
        const quantity = parseInt(document.getElementById('modalRegisterQuantity').value) || 1;
        const comment = document.getElementById('modalRegisterComment').value;

        if (!addressStr) {
            this.ui.showNotification('Please enter an address', 'error');
            return;
        }

        // Parse address (supports hex like 0x0000 or decimal like 40001)
        let address;
        if (addressStr.startsWith('0x') || addressStr.startsWith('0X')) {
            address = parseInt(addressStr, 16);
        } else {
            address = ModbusMaster.convertAddress(addressStr, type);
        }

        if (quantity > 125) {
            this.ui.showNotification('Maximum 125 registers per group', 'error');
            return;
        }

        // Add multiple registers if quantity > 1
        const configs = [];
        for (let i = 0; i < quantity; i++) {
            configs.push({
                type,
                address: address + i,
                alias: quantity === 1 ? alias : (alias ? `${alias}_${i}` : ''),
                comment: i === 0 ? comment : ''
            });
        }

        this.store.addRegisters(this.pendingRegisterGroupId, configs);
        this.ui.hideModal('modalAddRegister');
        this.ui.renderRegisterTable(this.pendingRegisterGroupId);
        this.ui.showNotification(`${quantity} register(s) added`, 'success');
    }

    // ===== Context Menu Handler =====
    handleContextMenuAction(action, itemType, itemId) {
        switch (action) {
            case 'connect':
                this.ui.selectedTreeItem = { type: itemType, id: itemId };
                this.handleOpenConnection();
                break;
            case 'disconnect':
                this.ui.selectedTreeItem = { type: itemType, id: itemId };
                this.handleCloseConnection();
                break;
            case 'remove':
                if (confirm('Are you sure you want to remove this connection?')) {
                    this.store.removeConnection(itemId);
                    this.ui.renderDeviceTree();
                    this.ui.showNotification('Connection removed', 'info');
                }
                break;
            case 'edit':
                if (itemType === 'slave') {
                    this.ui.selectedTreeItem = { type: itemType, id: itemId };
                    this.handleEditSlave();
                } else if (itemType === 'group') {
                    this.handleEditGroupFromContext(itemId);
                }
                break;
            case 'delete':
                if (itemType === 'slave') {
                    if (confirm('Are you sure you want to delete this slave?')) {
                        this.store.removeSlave(itemId);
                        this.ui.renderDeviceTree();
                        this.ui.showNotification('Slave deleted', 'info');
                    }
                } else if (itemType === 'group') {
                    if (confirm('Are you sure you want to delete this register group?')) {
                        this.store.removeRegisterGroup(itemId);
                        this.ui.renderDeviceTree();
                        this.ui.showNotification('Group deleted', 'info');
                    }
                }
                break;
            case 'newGroup':
                this.handleAddGroupFromContext(itemId);
                break;
            case 'addRegister':
                this.handleAddRegisterFromContext(itemId);
                break;
            case 'refresh':
                this.ui.selectedTreeItem = { type: 'group', id: itemId };
                this.handleRefreshRegisters();
                break;
            case 'startPolling':
                this.startPollingGroup(itemId);
                break;
            case 'stopPolling':
                this.store.stopPolling(itemId);
                this.ui.renderDeviceTree();
                this.ui.showNotification('Polling stopped', 'info');
                break;
        }
    }

    // ===== Register Reading/Writing =====
    async handleRefreshRegisters() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'group') return;

        const groupId = this.ui.selectedTreeItem.id;
        await this.readRegistersForGroup(groupId);
    }

    async readRegistersForGroup(groupId) {
        const group = this.store.getRegisterGroup(groupId);
        if (!group) return;

        const slave = this.store.getSlave(group.slaveId);
        if (!slave) return;

        const conn = this.store.getConnection(slave.connectionId);
        if (!conn || !conn.isConnected) {
            this.ui.showNotification('Not connected', 'error');
            return;
        }

        const registers = this.store.getRegistersForGroup(groupId);
        if (registers.length === 0) return;

        try {
            // Group registers by type
            const registersByType = {};
            for (const reg of registers) {
                if (!registersByType[reg.type]) {
                    registersByType[reg.type] = [];
                }
                registersByType[reg.type].push(reg);
            }

            const modbus = new ModbusMaster(slave.slaveId);

            for (const [type, regs] of Object.entries(registersByType)) {
                const typeInfo = REGISTER_TYPES[type];
                if (!typeInfo) continue;

                // Sort by address
                regs.sort((a, b) => a.address - b.address);

                // Read in chunks (max 125 registers)
                let i = 0;
                while (i < regs.length) {
                    const startAddr = regs[i].address;
                    let endIdx = i;

                    // Find consecutive or nearby registers
                    while (endIdx < regs.length - 1 &&
                           regs[endIdx + 1].address - startAddr < MAX_REGISTERS_PER_READ) {
                        endIdx++;
                    }

                    const quantity = regs[endIdx].address - startAddr + 1;
                    const frame = modbus.buildReadFrame(typeInfo.readFC, startAddr, quantity);

                    // Log TX
                    this.trafficLogger.log('TX', frame);
                    this.messageCount++;

                    try {
                        const response = await this.serialManager.sendWithTimeout(frame);

                        // Log RX
                        this.trafficLogger.log('RX', response);
                        this.messageCount++;

                        // Parse response
                        const values = modbus.parseReadResponse(response, typeInfo.readFC);

                        // Update register values
                        for (const reg of regs.slice(i, endIdx + 1)) {
                            const offset = reg.address - startAddr;
                            if (offset < values.length) {
                                reg.value = values[offset];
                                this.ui.updateRegisterValue(reg.id, reg.value);
                            }
                        }

                    } catch (error) {
                        this.trafficLogger.logError(error.message);
                        this.errorCount++;
                        this.ui.showNotification(`Read error: ${error.message}`, 'error');
                    }

                    i = endIdx + 1;
                }
            }

            this.ui.updateLastPoll();
            this.ui.updateValueEditor();
            this.ui.updateStatusBar();

        } catch (error) {
            this.trafficLogger.logError(error.message);
            this.errorCount++;
            this.ui.showNotification(`Error: ${error.message}`, 'error');
            this.ui.updateStatusBar();
        }
    }

    async writeRegister(register, value) {
        const group = this.store.getRegisterGroup(register.groupId);
        if (!group) throw new Error('Group not found');

        const slave = this.store.getSlave(group.slaveId);
        if (!slave) throw new Error('Slave not found');

        const conn = this.store.getConnection(slave.connectionId);
        if (!conn || !conn.isConnected) throw new Error('Not connected');

        const typeInfo = REGISTER_TYPES[register.type];
        if (!typeInfo || !typeInfo.writeFC) {
            throw new Error('Register type is read-only');
        }

        const modbus = new ModbusMaster(slave.slaveId);
        let frame;

        if (register.type === '0x') {
            // Write coil
            frame = modbus.buildWriteSingleCoilFrame(register.address, value);
        } else {
            // Write register
            frame = modbus.buildWriteSingleRegisterFrame(register.address, value);
        }

        // Log TX
        this.trafficLogger.log('TX', frame);
        this.messageCount++;

        const response = await this.serialManager.sendWithTimeout(frame);

        // Log RX
        this.trafficLogger.log('RX', response);
        this.messageCount++;

        // Validate response
        modbus.parseWriteResponse(response, typeInfo.writeFC);

        // Update local value
        register.value = value;
        this.ui.updateStatusBar();

        return true;
    }

    async handleTestConnection() {
        if (!this.ui.selectedTreeItem) return;

        let slave = null;
        if (this.ui.selectedTreeItem.type === 'slave') {
            slave = this.store.getSlave(this.ui.selectedTreeItem.id);
        } else if (this.ui.selectedTreeItem.type === 'group') {
            const group = this.store.getRegisterGroup(this.ui.selectedTreeItem.id);
            slave = group ? this.store.getSlave(group.slaveId) : null;
        }

        if (!slave) {
            this.ui.showNotification('Select a slave or register group first', 'warning');
            return;
        }

        const conn = this.store.getConnection(slave.connectionId);
        if (!conn || !conn.isConnected) {
            this.ui.showNotification('Not connected', 'error');
            return;
        }

        try {
            this.ui.showLoading('Testing connection...');

            const modbus = new ModbusMaster(slave.slaveId);
            const frame = modbus.buildReadFrame(FUNCTION_CODES.READ_HOLDING_REGISTERS, 0, 1);

            this.trafficLogger.log('TX', frame);
            this.messageCount++;

            const response = await this.serialManager.sendWithTimeout(frame);

            this.trafficLogger.log('RX', response);
            this.messageCount++;

            if (ModbusMaster.validateCRC(response)) {
                const fc = response[1];
                if (fc >= 0x80) {
                    // Exception response - but still means device responded
                    this.ui.showNotification(`Device responded with exception (this is OK - device is reachable)`, 'success');
                } else {
                    this.ui.showNotification('Connection test successful!', 'success');
                }
            } else {
                throw new Error('Invalid CRC in response');
            }

        } catch (error) {
            this.trafficLogger.logError(error.message);
            this.errorCount++;
            this.ui.showNotification(`Test failed: ${error.message}`, 'error');
        } finally {
            this.ui.hideLoading();
            this.ui.updateStatusBar();
        }
    }

    // ===== Polling =====
    startPollingGroup(groupId) {
        const group = this.store.getRegisterGroup(groupId);
        if (!group) return;

        const slave = this.store.getSlave(group.slaveId);
        if (!slave) return;

        const conn = this.store.getConnection(slave.connectionId);
        if (!conn || !conn.isConnected) {
            this.ui.showNotification('Not connected', 'error');
            return;
        }

        this.store.startPolling(groupId, () => {
            this.readRegistersForGroup(groupId);
        });

        this.ui.renderDeviceTree();
        this.ui.showNotification(`Polling started (${group.pollingInterval}ms)`, 'success');
    }

    handleToggleAutoPoll() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'group') return;

        const group = this.store.getRegisterGroup(this.ui.selectedTreeItem.id);
        if (!group) return;

        if (group.autoPolling) {
            // Stop polling
            this.store.stopPolling(this.ui.selectedTreeItem.id);
            this.ui.renderDeviceTree();
            this.ui.elements.btnAutoPollIcon.textContent = '▶️';
            this.ui.elements.btnAutoPollText.textContent = 'Auto-Poll';
            this.ui.showNotification('Polling stopped', 'info');
        } else {
            // Start polling
            this.startPollingGroup(this.ui.selectedTreeItem.id);
            this.ui.elements.btnAutoPollIcon.textContent = '⏹️';
            this.ui.elements.btnAutoPollText.textContent = 'Stop Poll';
        }
    }

    handleAddRegistersButton() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'group') return;
        this.handleAddRegisterFromContext(this.ui.selectedTreeItem.id);
    }

    handleResetRegisters() {
        if (!this.ui.selectedTreeItem || this.ui.selectedTreeItem.type !== 'group') return;

        const registers = this.store.getRegistersForGroup(this.ui.selectedTreeItem.id);
        for (const reg of registers) {
            reg.value = 0;
        }
        this.ui.renderRegisterTable(this.ui.selectedTreeItem.id);
        this.ui.showNotification('Registers reset to 0', 'info');
    }

    toggleTrafficLog() {
        const log = this.ui.elements.trafficLog;
        log.style.display = log.style.display === 'none' ? 'flex' : 'none';
    }
}

// ============================================
// Initialize Application
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ModbusEmulator();
});
