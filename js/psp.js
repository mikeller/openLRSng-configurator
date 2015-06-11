'use strict';

const PSP_SYNC1 = 0xB5;
const PSP_SYNC2 = 0x62;

const PSP_REQ_BIND_DATA =               1;
const PSP_REQ_RX_CONFIG =               2;
const PSP_REQ_RX_JOIN_CONFIGURATION =   3;
const PSP_REQ_SCANNER_MODE =            4;
const PSP_REQ_SPECIAL_PINS =            5;
const PSP_REQ_FW_VERSION =              6;
const PSP_REQ_NUMBER_OF_RX_OUTPUTS =    7;
const PSP_REQ_ACTIVE_PROFILE =          8;
const PSP_REQ_RX_FAILSAFE =             9;
const PSP_REQ_TX_CONFIG =               10;
const PSP_REQ_PPM_IN =                  11;
const PSP_REQ_DEFAULT_PROFILE =         12;

const PSP_SET_BIND_DATA =               101;
const PSP_SET_RX_CONFIG =               102;
const PSP_SET_TX_SAVE_EEPROM =          103;
const PSP_SET_RX_SAVE_EEPROM =          104;
const PSP_SET_TX_RESTORE_DEFAULT =      105;
const PSP_SET_RX_RESTORE_DEFAULT =      106;
const PSP_SET_ACTIVE_PROFILE =          107;
const PSP_SET_RX_FAILSAFE =             108;
const PSP_SET_TX_CONFIG =               109;
const PSP_SET_DEFAULT_PROFILE =         110;

const PSP_SET_EXIT =                    199;

const PSP_INF_ACK =                     201;
const PSP_INF_REFUSED =                 202;
const PSP_INF_CRC_FAIL =                203;
const PSP_INF_DATA_TOO_LONG =           204;

var PSP = {
    state:                  0,
    code:                   0,
    crc:                    0,
    payloadLengthExpected:  0,
    payloadLengthReceived:  0,
    buffer:                 null,
    bufferUint8:            null,
    retryCounter:           0,

    scrapsBuffer:           '',
    callbacks:              [],
    data:                   [],

    callbacks_cleanup: function () {
        for (var i = 0; i < this.callbacks.length; i++) {
            clearTimeout(this.callbacks[i].timer);
        }

        this.callbacks = [];
    },

    disconnect_cleanup: function () {
        this.state = 0; // reset packet state for "clean" initial entry (this is only required if user hot-disconnects)
        this.scrapsBuffer = '';
        this.retryCounter = 0;
        this.callbacks_cleanup();
        this.data = [];
    }
};

PSP.read = function (readInfo) {
    var data = new Uint8Array(readInfo.data);

    for (var i = 0; i < data.length; i++) {
        if (this.state == 0 || this.state == 1) {
            if (data[i] != 10) {
                this.scrapsBuffer += String.fromCharCode(data[i]);
            } else { // LF
                console.log('ASCII scraps: ' + this.scrapsBuffer);

                // clean up
                this.scrapsBuffer = '';
            }
        }

        switch (this.state) {
            case 0:
                if (data[i] == PSP_SYNC1) {
                    this.state++;
                }
                break;
            case 1:
                if (data[i] == PSP_SYNC2) {
                    this.state++;
                } else {
                    this.state = 0; // Restart and try again
                }
                break;
            case 2:
                this.code = data[i];
                this.crc = data[i];

                // this is a valid message, clean up scraps buffer
                this.scrapsBuffer = '';

                this.state++;
                break;
            case 3: // payload length LSB
                this.payloadLengthExpected = data[i];
                this.crc ^= data[i];

                this.state++;
                break;
            case 4: // payload length MSB
                this.payloadLengthExpected |= data[i] << 8;
                this.crc ^= data[i];

                // setup arraybuffer
                this.buffer = new ArrayBuffer(this.payloadLengthExpected);
                this.bufferUint8 = new Uint8Array(this.buffer);

                if (this.payloadLengthExpected) { // regular message with payload
                    this.state++;
                } else { // 0 payload message
                    this.state += 2;
                }
                break;
            case 5: // payload
                this.bufferUint8[this.payloadLengthReceived++] = data[i];
                this.crc ^= data[i];

                if (this.payloadLengthReceived >= this.payloadLengthExpected) {
                    this.state++;
                }
                break;
            case 6:
                if (this.crc == data[i]) {
                    if (this.data[this.code]) {
                        this.data[this.code]['_packet'] = this.buffer;
                    } else {
                        this.data[this.code] = {_packet: this.buffer};
                    }

                    this.retryCounter = 0;

                    // message received, process
                    this.process_data(this.code, this.data[this.code]);
                } else {
                    // crc failed
                    console.log('crc failed, code: ' + this.code);

                    // retry
                    if (this.retryCounter < 3) {
                        for (var i = this.callbacks.length - 1; i >= 0; i--) {
                            if (this.callbacks[i].code == this.code) {
                                this.retryCounter++;
                                serial.send(this.callbacks[i].requestBuffer, false);
                                break;
                            }
                        }
                    } else {
                        GUI.log(chrome.i18n.getMessage('error_psp_crc_failed', [this.code]));

                        // unlock disconnect button (this is a special case)
                        GUI.connect_lock = false;
                    }
                }

                // Reset variables
                this.payloadLengthReceived = 0;
                this.state = 0;
                break;

            default:
                console.log('Unknown state detected: ' + this.state);
        }
    }
};

PSP.process_data = function (code, obj) {
    var data = new DataView(obj._packet, 0); // DataView (allowing us to view arrayBuffer as struct/union)

    switch (code) {
        case PSP_REQ_BIND_DATA:
            var preparedDataObject = PSP.read_struct(STRUCT_PATTERN.BIND_DATA, data);

            for (var key in preparedDataObject) {
                obj[key] = preparedDataObject[key];
            }

            GUI.log(chrome.i18n.getMessage('bind_data_received'));
            break;
        case PSP_REQ_RX_CONFIG:
            var preparedDataObject = PSP.read_struct(STRUCT_PATTERN.RX_CONFIG, data);

            for (var key in preparedDataObject) {
                obj[key] = preparedDataObject[key];
            }

            GUI.log(chrome.i18n.getMessage('receiver_config_data_received'));
            break;
        case PSP_REQ_RX_JOIN_CONFIGURATION:
            break;
        case PSP_REQ_SCANNER_MODE:
            break;
        case PSP_REQ_SPECIAL_PINS:
            obj.pins = [];

            for (var i = 0; i < data.byteLength; i += 2) {
                var object = {'pin': data.getUint8(i), 'type': data.getUint8(i + 1)};
                obj.pins.push(object);
            }
            break;
        case PSP_REQ_FW_VERSION:
            // version number in single uint16 [8bit major][4bit][4bit] fetched from mcu
            obj.firmwareVersion = data.getUint16(0, 1);
            break;
        case PSP_REQ_NUMBER_OF_RX_OUTPUTS:
            obj.outputs = data.getUint8(0);
            break;
        case PSP_REQ_ACTIVE_PROFILE:
            obj.profile = data.getUint8(0);
            break;
        case PSP_REQ_RX_FAILSAFE:
            // dump previous data
            obj.values = [];

            if (data.byteLength > 1) {
                // valid failsafe values received (big-endian)
                GUI.log(chrome.i18n.getMessage('receiver_failsafe_data_received'));

                for (var i = 0; i < data.byteLength; i += 2) {
                    obj.values.push(data.getUint16(i, 0));
                }
            } else if (data.byteLength == 1) {
                // 0x01 = failsafe not set
                GUI.log(chrome.i18n.getMessage('receiver_failsafe_data_not_saved_yet'));

                for (var i = 0; i < 16; i++) {
                    obj.values.push(1000);
                }
            } else {
                // 0x00 = call failed
            }
            break;
        case PSP_REQ_TX_CONFIG:
            var preparedDataObject = PSP.read_struct(STRUCT_PATTERN.TX_CONFIG, data);

            for (var key in preparedDataObject) {
                obj[key] = preparedDataObject[key];
            }
            break;
        case PSP_REQ_PPM_IN:
            obj.channels = [];
            obj.ppmAge = data.getUint8(0);

            for (var i = 0, needle = 1; needle < data.byteLength - 1; i++, needle += 2) {
                obj.channels[i] = data.getUint16(needle, 1);
            }
            break;
        case PSP_REQ_DEFAULT_PROFILE:
            obj.profile = data.getUint8(0);
            break;
        case PSP_SET_BIND_DATA:
            if (data.getUint8(0)) {
                GUI.log(chrome.i18n.getMessage('transmitter_bind_data_sent_ok'));
            } else {
                GUI.log(chrome.i18n.getMessage('transmitter_bind_data_sent_fail'));
            }
            break;
        case PSP_SET_RX_CONFIG:
            if (data.getUint8(0)) {
                GUI.log(chrome.i18n.getMessage('receiver_config_data_sent_ok'));
            } else {
                GUI.log(chrome.i18n.getMessage('receiver_config_data_sent_fail'));
            }
            break;
        case PSP_SET_TX_SAVE_EEPROM:
            if (data.getUint8(0)) {
                GUI.log(chrome.i18n.getMessage('transmitter_eeprom_save_ok'));
            } else {
                GUI.log(chrome.i18n.getMessage('transmitter_eeprom_save_fail'));
            }
            break;
        case PSP_SET_RX_SAVE_EEPROM:
            if (data.getUint8(0)) {
                GUI.log(chrome.i18n.getMessage('receiver_eeprom_save_ok'));
            } else {
                GUI.log(chrome.i18n.getMessage('receiver_eeprom_save_fail'));
            }
            break;
        case PSP_SET_TX_RESTORE_DEFAULT:
            GUI.log(chrome.i18n.getMessage('transmitter_configuration_restored'));
            break;
        case PSP_SET_RX_RESTORE_DEFAULT:
            GUI.log(chrome.i18n.getMessage('receiver_configuration_restored'));
            break;
        case PSP_SET_ACTIVE_PROFILE:
            break;
        case PSP_SET_RX_FAILSAFE:
            if (data.getUint8(0)) {
                GUI.log(chrome.i18n.getMessage('receiver_failsafe_data_save_ok'));
            } else {
                GUI.log(chrome.i18n.getMessage('receiver_failsafe_data_save_fail'));
            }
            break;
        case PSP_SET_TX_CONFIG:
            if (data.getUint8(0)) {
                console.log('TX_config saved');
            } else {
                console.log('TX_config not saved');
            }
            break;
        case PSP_SET_DEFAULT_PROFILE:
            break;
        case PSP_SET_EXIT:
            break;

        default:
            console.log('Unknown code: ' + code);
            GUI.log(chrome.i18n.getMessage('error_psp_unknown_code', [code]));
    }

    // trigger callbacks, cleanup/remove callback after trigger
    for (var i = this.callbacks.length - 1; i >= 0; i--) { // itterating in reverse because we use .splice which modifies array length
        if (this.callbacks[i].code == code) {
            // save callback reference
            var callback = this.callbacks[i].callback;

            // remove timeout
            if (this.callbacks[i].timeout) clearTimeout(this.callbacks[i].timer);

            // remove object from array
            this.callbacks.splice(i, 1);

            // fire callback
            if (callback) callback({'code': code, 'data': data, 'length': data.byteLength});
        }
    }
};

PSP.send_message = function (code, data, callback_sent, callback_psp, timeout) {
    var self = this,
        bufferOut,
        bufView;

    // always reserve 6 bytes for protocol overhead !
    if (typeof data === 'object') {
        var size = data.length + 6,
            checksum = 0;

        bufferOut = new ArrayBuffer(size);
        bufView = new Uint8Array(bufferOut);

        bufView[0] = PSP_SYNC1;
        bufView[1] = PSP_SYNC2;
        bufView[2] = code;
        bufView[3] = lowByte(data.length);
        bufView[4] = highByte(data.length);

        checksum = bufView[2] ^ bufView[3] ^ bufView[4];

        for (var i = 0; i < data.length; i++) {
            bufView[i + 5] = data[i];
            checksum ^= bufView[i + 5];
        }

        bufView[5 + data.length] = checksum;
    } else {
        bufferOut = new ArrayBuffer(7);
        bufView = new Uint8Array(bufferOut);

        bufView[0] = PSP_SYNC1;
        bufView[1] = PSP_SYNC2;
        bufView[2] = code;
        bufView[3] = 0x01; // payload length LSB
        bufView[4] = 0x00; // payload length MSB
        bufView[5] = data;
        bufView[6] = bufView[2] ^ bufView[3] ^ bufView[4] ^ bufView[5]; // crc
    }

    // define PSP callback for next code
    if (callback_psp) {
        var obj;

        if (timeout) {
            obj = {'code': code, 'requestBuffer': bufferOut, 'callback': callback_psp, 'timeout': timeout};
            obj.timer = setTimeout(function() {
                // fire callback
                callback_psp(false);

                // remove object from array
                var index = self.callbacks.indexOf(obj);
                if (index > -1) self.callbacks.splice(index, 1);
            }, timeout);
        } else {
            obj = {'code': code, 'requestBuffer': bufferOut, 'callback': callback_psp, 'timeout': false};
        }

        this.callbacks.push(obj);
    }

    serial.send(bufferOut, function(writeInfo) {
        if (writeInfo.bytesSent == bufferOut.byteLength) {
            if (callback_sent) {
                callback_sent();
            }
        }
    });
};

PSP.send_config = function (type, callback) {
    if (!CONFIGURATOR.readOnly) {
        if (type == 'TX') {
            var tx_data = PSP.write_struct(STRUCT_PATTERN.TX_CONFIG, PSP.data[PSP_REQ_TX_CONFIG]);
            var bind_data = PSP.write_struct(STRUCT_PATTERN.BIND_DATA, PSP.data[PSP_REQ_BIND_DATA]);

            var send_bind_data = function () {
                PSP.send_message(PSP_SET_BIND_DATA, bind_data, false, save_eeprom);
            }

            var save_eeprom = function () {
                PSP.send_message(PSP_SET_TX_SAVE_EEPROM, false, false, (callback) ? callback : undefined);
            }

            PSP.send_message(PSP_SET_TX_CONFIG, tx_data, false, send_bind_data);

        } else if (type == 'RX') {
            var rx_data = PSP.write_struct(STRUCT_PATTERN.RX_CONFIG, PSP.data[PSP_REQ_RX_CONFIG]);

            var save_to_eeprom = function () {
                PSP.send_message(PSP_SET_RX_SAVE_EEPROM, false, false, (callback) ? callback : undefined);
            }

            PSP.send_message(PSP_SET_RX_CONFIG, rx_data, false, save_to_eeprom);
        }
    } else {
        GUI.log(chrome.i18n.getMessage('running_in_compatibility_mode'));
    }
};

PSP.read_struct = function (pattern, data) {
    var obj = {},
        needle = 0,
        i, j;

    for (i = 0; i < pattern.length; i++) {
        switch (pattern[i].type) {
            case 'u8':
                obj[pattern[i].name] = data.getUint8(needle);
                needle += 1;
                break;
            case 'u16':
                obj[pattern[i].name] = data.getUint16(needle, 1);
                needle += 2;
                break;
            case 'u32':
                obj[pattern[i].name] = data.getUint32(needle, 1);
                needle += 4;
                break;
            case 'array':
                obj[pattern[i].name] = [];

                for (j = 0; j < pattern[i].length; j++) {
                    if (pattern[i].of == 'u8') {
                        obj[pattern[i].name].push(data.getUint8(needle));
                        needle += 1;
                    } else {
                        console.log('Pattern type not supported')
                        return false;
                    }
                }
                break;

            default:
                console.log('Pattern type not supported')
                return false;
        }
    }

    return obj;
};

PSP.write_struct = function (pattern, data) {
    var buffSize = 0,
        needle = 0,
        aBuff,
        aBuffView,
        i, j;

    for (i = 0; i < pattern.length; i++) {
        switch (pattern[i].type) {
            case 'u8':
                buffSize += 1;
                break;
            case 'u16':
                buffSize += 2;
                break;
            case 'u32':
                buffSize += 4;
                break;
            case 'array':
                buffSize += pattern[i].length;
                break;

            default:
                console.log('Pattern type not supported')
                return false;
        }
    }

    aBuff = new ArrayBuffer(buffSize);
    aBuffView = new DataView(aBuff, 0);

    for (i = 0; i < pattern.length; i++) {
        switch (pattern[i].type) {
            case 'u8':
                aBuffView.setUint8(needle, data[pattern[i].name]);
                needle += 1;
                break;
            case 'u16':
                aBuffView.setUint16(needle, data[pattern[i].name], 1);
                needle += 2;
                break;
            case 'u32':
                aBuffView.setUint32(needle, data[pattern[i].name], 1);
                needle += 4;
                break;
            case 'array':
                for (j = 0; j < pattern[i].length; j++) {
                    aBuffView.setUint8(needle, data[pattern[i].name][j]);
                    needle += 1;
                }
                break;

            default:
                // fall through, since default case was already handled in first for loop
        }
    }

    return new Uint8Array(aBuff);
};
