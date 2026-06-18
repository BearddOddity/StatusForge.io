import socket, json, os, sys, threading, time

def forge_bootstrap():
    """Ensures all necessary tools are in the box before starting Spark."""
    import subprocess
    required = ["Pillow", "pystray", "psutil"]
    missing = []
    for lib in required:
        try: __import__('PIL' if lib == 'Pillow' else lib)
        except ImportError: missing.append(lib)
    if missing:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing)
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except: pass

forge_bootstrap()

import tkinter as tk
from PIL import Image, ImageDraw
import pystray
from pystray import MenuItem as item
try: import forge_scanner
except ImportError: forge_scanner = None

class StatusForgeSpark:
    def __init__(self):
        self.is_running = True
        self.spark_config = {"scan_interval": 5, "pin": "0000", "hub_name": "Searching..."}
        self.current_game = {"title": None, "process": None}
        
        self.root = tk.Tk()
        self.root.title("StatusForge Spark")
        self.root.geometry("280x165")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(f"+{(sw-280)//2}+{(sh-165)//2}")

        self.build_ui()
        self.icon = self.build_tray_icon()

        threading.Thread(target=self.icon.run_detached, daemon=True).start()
        threading.Thread(target=self.hub_listener, daemon=True).start()
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        threading.Thread(target=self.scanner_loop, daemon=True).start()

    def build_ui(self):
        c_bg, c_card, c_accent, c_text, c_dim = "#121214", "#1E1E24", "#FFD700", "#FFFFFF", "#AAAAAA"
        self.root.configure(bg=c_bg)
        
        self.main = tk.Frame(self.root, bg=c_card, highlightthickness=1, highlightbackground="#333333")
        self.main.pack(expand=True, fill="both", padx=2, pady=2)

        head = tk.Frame(self.main, bg=c_card, cursor="fleur")
        head.pack(fill="x", padx=15, pady=(12, 5))
        tk.Label(head, text="⚡ SPARK AGENT", font=("Arial", 10, "bold"), bg=c_card, fg=c_accent).pack(side="left")
        self.dot = tk.Frame(head, width=8, height=8, bg="#444444")
        self.dot.pack(side="right")

        info = tk.Frame(self.main, bg="black", padx=10, pady=8)
        info.pack(fill="x", padx=15, pady=5)
        tk.Label(info, text="BROADCASTING TO", font=("Arial", 7, "bold"), bg="black", fg=c_dim).pack(anchor="w")
        self.lbl_hub = tk.Label(info, text=self.spark_config["hub_name"], font=("Courier", 10, "bold"), bg="black", fg="#FFFFFF")
        self.lbl_hub.pack(anchor="w")

        pin_f = tk.Frame(self.main, bg=c_card)
        pin_f.pack(fill="x", padx=15, pady=5)
        tk.Label(pin_f, text="NETWORK PIN", font=("Arial", 8, "bold"), bg=c_card, fg=c_dim).pack(side="left")
        self.pin_var = tk.StringVar(value=self.spark_config["pin"])
        self.pin_entry = tk.Entry(pin_f, textvariable=self.pin_var, font=("Courier", 12, "bold"), bg=c_bg, fg=c_accent, 
                                  insertbackground=c_accent, borderwidth=0, width=6, justify="center")
        self.pin_entry.pack(side="right")

        btns = tk.Frame(self.main, bg=c_card)
        btns.pack(fill="x", padx=15, pady=(10, 10))
        tk.Button(btns, text="STOW", command=self.hide, bg="#2A2A32", fg=c_dim, font=("Arial", 8, "bold"), 
                  relief="flat", borderwidth=0, cursor="hand2", activebackground="#3A3A45", activeforeground="white").pack(side="left", expand=True, fill="x", padx=(0, 5))
        tk.Button(btns, text="KILL", command=self.quit, bg="#2A2A32", fg=c_dim, font=("Arial", 8, "bold"), 
                  relief="flat", borderwidth=0, cursor="hand2", activebackground="#E63900", activeforeground="white").pack(side="right", expand=True, fill="x", padx=(5, 0))

        for w in [head, self.main, info, pin_f]:
            w.bind("<ButtonPress-1>", self.start_move)
            w.bind("<B1-Motion>", self.do_move)
        
        # KEYBOARD FIX: Ensure the window can receive input focus!
        self.root.bind("<Button-1>", lambda e: self.root.focus_set())

    def start_move(self, e): self.x, self.y = e.x, e.y
    def do_move(self, e): self.root.geometry(f"+{self.root.winfo_x() - self.x + e.x}+{self.root.winfo_y() - self.y + e.y}")
    
    def hide(self): self.root.withdraw()
    def show(self, icon=None, item=None): self.root.deiconify(); self.root.focus_force()
    def quit(self, icon=None, item=None):
        self.is_running = False
        if self.icon: self.icon.stop()
        self.root.destroy()
        os._exit(0)

    def build_tray_icon(self):
        img = Image.new('RGB', (64, 64), color=(18, 18, 20))
        d = ImageDraw.Draw(img)
        d.polygon([(32, 10), (45, 30), (35, 30), (40, 54), (20, 30), (30, 30)], fill=(255, 215, 0))
        return pystray.Icon("StatusForge Spark", img, "StatusForge Spark", (item('Open', self.show), item('Quit', self.quit)))

    def hub_listener(self):
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try: u.bind(('', 53736))
        except: return
        while self.is_running:
            try:
                data, addr = u.recvfrom(1024)
                p = json.loads(data.decode('utf-8'))
                if p.get("app") == "StatusForge_Hub":
                    self.spark_config["hub_name"] = p.get("hub_name", addr[0])
                    self.root.after(0, lambda: self.lbl_hub.config(text=self.spark_config["hub_name"]))
            except: pass

    def heartbeat_loop(self):
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        while self.is_running:
            try:
                payload = {
                    "app": "StatusForge_Spark", "hostname": socket.gethostname(),
                    "game": self.current_game['title'], "process": self.current_game['process'],
                    "pin": self.pin_var.get()[:4], "command": "heartbeat"
                }
                u.sendto(json.dumps(payload).encode('utf-8'), ('<broadcast>', 53735))
                self.root.after(0, lambda: self.dot.config(bg="#53F518"))
                time.sleep(0.5)
                self.root.after(0, lambda: self.dot.config(bg="#FFD700"))
            except: pass
            time.sleep(10)

    def scanner_loop(self):
        if not forge_scanner: return
        s = forge_scanner.ForgeWaterfall(lambda m,l,c: None)
        while self.is_running:
            res = s.scout_active_session()
            self.current_game = res if res else {"title": None, "process": None}
            time.sleep(5)

if __name__ == "__main__":
    app = StatusForgeSpark()
    app.root.mainloop()
