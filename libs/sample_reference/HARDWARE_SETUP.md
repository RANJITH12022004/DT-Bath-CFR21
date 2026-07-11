# Hardware Setup - Tablet Hardness Tester

Pin mapping and configuration for Raspberry Pi connectivity with ESP32, printers, and RTC.

---

## Pin Mapping

### ESP32 UART

| Raspberry Pi       | ESP32  | Notes                    |
|--------------------|--------|--------------------------|
| GPIO14 (Pin 8)     | RX     | Pi TX -> ESP32 RX        |
| GPIO15 (Pin 10)    | TX     | Pi RX -> ESP32 TX        |
| GND                | GND    | Common ground            |

**Device node:** `/dev/serial0` (primary UART)

---

### Thermal Printer

| Raspberry Pi   | Printer | Device Node   |
|----------------|---------|---------------|
| GPIO 4 (TX)    | RX      |               |
| GPIO 5 (RX)    | TX      | /dev/ttyAMA3  |
| GND            | GND     |               |

---

### A4 Printer

| Raspberry Pi   | Printer | Device Node   |
|----------------|---------|---------------|
| GPIO 8 (TX)    | RX      |               |
| GPIO 9 (RX)    | TX      | /dev/ttyAMA4  |
| GND            | GND     |               |

---

### External Weighing Scale UART

| Raspberry Pi       | Scale | Device Node (typical) |
|--------------------|-------|-----------------------|
| GPIO12 (Pin 32)    | RX    | /dev/ttyAMA5          |
| GPIO13 (Pin 33)    | TX    |                       |
| GND                | GND   |                       |

Scale serial format used by app:
- Baud: `9600`
- Data bits: `8`
- Parity: `N`
- Stop bits: `1`
- Reader mode: `frame` (fixed-size frames, default frame size `8` bytes)

---

### RTC (DS1307)

| Raspberry Pi      | RTC Module | Notes          |
|-------------------|------------|----------------|
| 3.3V (Pin 1)      | VCC        |                |
| GND               | GND        |                |
| GPIO2 / SDA (Pin 3)| SDA       | I2C Data       |
| GPIO3 / SCL (Pin 5)| SCL       | I2C Clock      |

---

## Environment Variables

Set these before running the application (e.g. in `.env` or systemd service):

| Variable       | Default        | Description                    |
|----------------|----------------|--------------------------------|
| ESP_PORT       | /dev/serial0   | ESP32 UART device              |
| ESP_BAUD       | 9600           | ESP32 baud rate                |
| THERMAL_PORT   | /dev/ttyAMA3   | Thermal printer UART           |
| THERMAL_BAUD   | 9600           | Thermal printer baud rate      |
| A4_PORT        | /dev/ttyAMA4   | A4 printer UART                |
| A4_BAUD        | 9600           | A4 printer baud rate           |
| SCALE_PORT     | /dev/ttyAMA5   | External scale UART device     |
| SCALE_BAUD     | 9600           | External scale baud rate       |
| SCALE_BYTESIZE | 8              | External scale data bits       |
| SCALE_PARITY   | N              | External scale parity          |
| SCALE_STOPBITS | 1              | External scale stop bits       |
| SCALE_READ_MODE | frame         | `frame` or `line`             |
| SCALE_FRAME_SIZE | 8            | Bytes per fixed frame         |

---

## Raspberry Pi config.txt

Add these lines to `/boot/firmware/config.txt` (Pi 4/5) or `/boot/config.txt` (older Pi). Reboot after changes.

```txt
# Enable UART (primary for ESP32 - usually enabled by default)
enable_uart=1

# Thermal printer: GPIO 4/5 -> /dev/ttyAMA3
dtoverlay=uart3,txd4_pin=4,rxd5_pin=5

# A4 printer: GPIO 8/9 -> /dev/ttyAMA4
dtoverlay=uart4,txd8_pin=8,rxd9_pin=9

# External scale: GPIO12/13 -> /dev/ttyAMA5
dtoverlay=uart5,txd12_pin=12,rxd13_pin=13

# RTC (DS1307) - I2C on GPIO2/3
dtoverlay=i2c-rtc,ds1307
```

**Note:** Overlay parameter names (e.g. `txd4_pin`, `rxd5_pin`) may vary by Raspberry Pi model. If devices do not appear, check the [Raspberry Pi documentation](https://www.raspberrypi.com/documentation/computers/configuration.html) for your model.

---

## Verify Devices

After reboot:

```bash
# Check ESP32 (primary UART)
ls -la /dev/serial0

# Check thermal printer
ls -la /dev/ttyAMA3

# Check A4 printer
ls -la /dev/ttyAMA4

# Check external scale UART (GPIO12/13)
ls -la /dev/ttyAMA5

# Check RTC (i2c)
sudo i2cdetect -y 1
# DS1307 typically appears at 0x68
```

Scale API checks:

```bash
curl -s http://127.0.0.1:5000/api/scale/status
curl -s -X POST http://127.0.0.1:5000/api/scale/read -H "Content-Type: application/json" -d "{\"timeout_sec\":10}"
```

---

## RTC API

- `GET /api/rtc/date` - Read RTC date/time
- `POST /api/rtc/date` - Set RTC (body: `{"datetime": "2025-02-12T14:30:00"}`). Requires **Admin** or **Factory** role.

**Edit Date & Time** (and setting the hardware RTC) is only allowed for users with role **Admin** or **Factory**. If you use a member account (e.g. username `rle`), ensure that member has role **Admin** (or Factory) in the app so that both system time and the DS1307 on SDA/SCL are updated when you apply date and time.

### RTC: I2C only (no hwclock)

The app talks to the DS1307 over **I2C** (smbus). Install the Python I2C library on the Pi:

```bash
sudo apt-get install python3-smbus
```

If the app runs as a **non-root user** (e.g. `rle`), add that user to the `i2c` group so it can access `/dev/i2c-1`:

```bash
sudo usermod -aG i2c rle
```

Then log out and back in (or reboot). Setting system time when applying date/time still needs `date`; if the process is not root, add to sudoers:

```
rle ALL=(ALL) NOPASSWD: /usr/bin/date
```

If the service runs as **root** (e.g. `User=root` in `kiosk.service`), no extra permissions are needed.
