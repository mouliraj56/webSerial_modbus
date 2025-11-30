# Modbus RTU Master Emulator

A production-ready, browser-based Modbus RTU Master (Client) application that communicates with physical Modbus RTU devices through USB-RS485 adapters using the Web Serial API.

## 🚀 How to Use

### Getting Started

1. **Open the Application**
   - Open `src/index.html` in a supported browser (Chrome, Edge, or Opera)
   - Or deploy to any static hosting (GitHub Pages, Netlify, etc.)

2. **Create a Connection**
   - Click **"New Connection"** in the toolbar
   - Configure serial settings (Baud Rate, Parity, Data Bits, Stop Bits)
   - Click **"Select Port"** and choose your USB-RS485 adapter from the browser prompt
   - The connection will open automatically

3. **Add a Slave Device**
   - Select the connection in the device tree
   - Click **"New Slave"** or right-click the connection
   - Enter the Slave ID (1-247) and an optional alias

4. **Create Register Groups**
   - Right-click on a slave and select **"New Group"**
   - Enter a group name and polling interval (in milliseconds)

5. **Add Registers**
   - Right-click on a register group and select **"Add Register"**
   - Choose register type:
     - `0x` - Coils (read/write, FC 01/05)
     - `1x` - Discrete Inputs (read-only, FC 02)
     - `3x` - Input Registers (read-only, FC 04)
     - `4x` - Holding Registers (read/write, FC 03/06)
   - Enter the address (hex like `0x0000` or Modbus notation like `40001`)
   - Specify quantity to add multiple consecutive registers

6. **Read/Write Registers**
   - Click on a register group to view its registers
   - Click **"Refresh"** to read all registers in the group
   - Double-click a writable register cell to edit its value
   - Use the **Value Editor** panel to view different data interpretations

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New Connection |
| `Ctrl+O` | Open Connection |
| `Ctrl+R` | Refresh Registers |
| `Ctrl+T` | Test Connection |
| `Esc` | Close modals/menus |

### Value Interpretation

Select registers in the table to view their values in different formats:

- **Numeric Tab**: Unsigned, Signed, Hex, Binary (single register)
- **Long Tab**: 32-bit integer with byte order options (2 consecutive registers)
- **Float Tab**: IEEE 754 float with byte order options (2 consecutive registers)
- **Double Tab**: 64-bit double precision (4 consecutive registers)
- **String Tab**: ASCII string interpretation (any number of registers)

### Auto-Polling

- Right-click a register group and select **"Start Polling"**
- Registers will be read automatically at the configured interval
- Click **"Stop Polling"** to disable

### Traffic Log

- Click **"Traffic Log"** to view raw Modbus frames
- TX (sent) and RX (received) frames are displayed in hex
- Use **Copy** to export the log

## ⚠️ Limitations

### Browser Compatibility

- **Requires Web Serial API** - Only works in:
  - Google Chrome 89+
  - Microsoft Edge 89+
  - Opera 75+
- **Does NOT work in**: Firefox, Safari, mobile browsers

### Hardware Requirements

- Requires a **USB-RS485 adapter** (FTDI, CH340, CP2102, etc.)
- The adapter must be recognized by your operating system
- Only one application can use a serial port at a time

### Protocol Limitations

- **RTU mode only** - ASCII mode is not supported
- **Master/Client only** - Cannot act as a Modbus slave/server
- **No TCP/IP** - Only serial RTU communication
- Maximum 125 registers per read request (Modbus protocol limit)
- Maximum 123 registers per write request

### Data Persistence

- Configuration is saved to **browser localStorage**
- Data is browser and origin-specific (won't sync across devices)
- Serial port permissions must be re-granted on each browser session

### Security

- Web Serial API requires **HTTPS** or **localhost**
- User must explicitly grant permission for each port
- No authentication/encryption for Modbus communication (protocol limitation)

### Known Issues

- Serial port objects cannot be persisted; you must re-select the port after page refresh
- Some USB-RS485 adapters may have driver compatibility issues
- Response timeout is fixed at 2 seconds

## 📁 Project Structure

```
webSerial_modbus/
├── README.md
└── src/
    ├── index.html    # Main HTML structure
    ├── style.css     # Styling (dark/light mode)
    └── script.js     # Application logic
```

## 🔧 Technical Details

- **Pure vanilla JavaScript** - No frameworks or dependencies
- **Offline capable** - Works without internet after initial load
- **~140 KB total** - Lightweight and fast
- **Modular architecture** - SerialManager, ModbusMaster, Store, UIManager classes

## 📄 License

MIT License - Feel free to use, modify, and distribute.

