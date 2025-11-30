# 🔌 Modbus RTU Master Emulator

A free, browser-based tool for communicating with Modbus RTU devices. No installation required — just plug in your USB-RS485 adapter and start reading/writing registers.

**[▶️ Launch Application](index.html)**

---

## ✨ Features

- 🌐 **Runs entirely in your browser** — no software to install
- 🔗 **Direct hardware access** via USB-RS485 adapters
- 📊 **Read & write** coils, discrete inputs, input registers, and holding registers
- 🔄 **Auto-polling** with configurable intervals
- 📈 **Multiple data formats** — view values as integers, floats, hex, binary, or strings
- 🌙 **Dark mode** interface
- 💾 **Saves your configuration** automatically in the browser

---

## 🖥️ Browser Requirements

This application uses the **Web Serial API**, which is only available in:

| Browser | Supported |
|---------|-----------|
| Google Chrome 89+ | ✅ Yes |
| Microsoft Edge 89+ | ✅ Yes |
| Opera 75+ | ✅ Yes |
| Firefox | ❌ No |
| Safari | ❌ No |
| Mobile browsers | ❌ No |

---

## 🛠️ What You Need

1. A **USB-RS485 adapter** (e.g., FTDI, CH340, CP2102)
2. A **Modbus RTU slave device** to communicate with
3. A supported browser (see above)

---

## 📖 Quick Start Guide

### 1. Connect Your Hardware
Plug your USB-RS485 adapter into your computer and connect it to your Modbus device.

### 2. Create a Connection
- Click **"New Connection"**
- Set your serial parameters (baud rate, parity, etc.)
- Click **"Select Port"** and choose your adapter

### 3. Add Your Device
- Click **"New Slave"**
- Enter the device's Slave ID (1-247)

### 4. Add Registers
- Right-click your slave → **"New Group"**
- Right-click the group → **"Add Register"**
- Choose the register type and address

### 5. Read Data
- Select your register group in the tree
- Click **"Refresh"** to read values
- Or enable **auto-polling** for continuous updates

---

## 📋 Supported Modbus Functions

| Code | Function | Type |
|------|----------|------|
| 01 | Read Coils | `0x` |
| 02 | Read Discrete Inputs | `1x` |
| 03 | Read Holding Registers | `4x` |
| 04 | Read Input Registers | `3x` |
| 05 | Write Single Coil | `0x` |
| 06 | Write Single Register | `4x` |
| 15 | Write Multiple Coils | `0x` |
| 16 | Write Multiple Registers | `4x` |

---

## 🔢 Data Interpretation

Select one or more registers to view values in different formats:

| Format | Registers Needed | Description |
|--------|------------------|-------------|
| Unsigned/Signed | 1 | 16-bit integer |
| Hex/Binary | 1 | Raw representation |
| Long (32-bit) | 2 | With byte order options |
| Float (32-bit) | 2 | IEEE 754, multiple byte orders |
| Double (64-bit) | 4 | Big/little endian |
| String | Any | ASCII text |

---

## ⚠️ Limitations

| Limitation | Details |
|------------|---------|
| **RTU only** | ASCII mode not supported |
| **Master only** | Cannot emulate a slave device |
| **Serial only** | No Modbus TCP/IP support |
| **Max read** | 125 registers per request |
| **Port re-selection** | Must re-select port after page refresh |
| **Single port** | One app per serial port |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + N` | New Connection |
| `Ctrl + O` | Open Connection |
| `Ctrl + R` | Refresh Registers |
| `Ctrl + T` | Test Connection |
| `Esc` | Close dialogs |

---

## 🔒 Privacy & Security

- ✅ **No data leaves your browser** — everything runs locally
- ✅ **No tracking or analytics**
- ✅ **No server required** — works offline after loading
- ✅ **Open source** — inspect the code yourself

---

## 💡 Tips

- **Test Connection**: Use the `TC` button to verify your device responds
- **Traffic Log**: Click "Traffic Log" to see raw Modbus frames for debugging
- **Byte Order**: Industrial devices vary — try different byte orders (ABCD, CDAB, etc.) for float values
- **Address Formats**: Enter addresses as `40001` or `0x0000` — both work

---

## 🐛 Troubleshooting

**"No port selected"**
→ Make sure your USB adapter is plugged in and drivers are installed

**"Access denied"**
→ Close any other application using the serial port

**Timeout errors**
→ Check wiring, baud rate, parity, and slave ID settings

**Wrong values**
→ Try different byte order interpretations in the Value Editor

---

## 📄 License

MIT License — free to use, modify, and distribute.

