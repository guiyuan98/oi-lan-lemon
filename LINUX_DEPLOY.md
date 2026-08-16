# Linux 部署教程

本教程部署网站和 Linux 版 `lemon-headless`，推荐使用 **Debian 13** 或 **Ubuntu 26.04 LTS**。不要直接使用 Ubuntu 24.04 的系统 Qt：其 Qt 6.4 低于 LemonLime 当前要求的 Qt 6.8。

Linux 版 worker 使用 Bubblewrap 隔离学生程序，比直接在 Windows 上运行更合适，但仍应使用专门的非 root 账户和可还原的比赛机器。不要把服务直接暴露到公网。

## 1. 安装系统依赖

```bash
sudo apt update
sudo apt install -y \
  build-essential cmake ninja-build git curl xz-utils bubblewrap \
  qt6-base-dev qt6-base-dev-tools qt6-tools-dev qt6-tools-dev-tools \
  qt6-l10n-tools libgl1-mesa-dev
```

确认 Qt 不低于 6.8：

```bash
qmake6 -query QT_VERSION
```

项目需要 Node.js 22.5 或更高版本。Debian 13 自带的 Node.js 20 不满足要求；建议按 [Node.js 官方下载页](https://nodejs.org/en/download)安装当前 LTS 版 Node.js 24：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
nvm alias default 24
node --version
npm --version
```

执行联网安装脚本前应先打开链接检查内容。如果机器已经安装 Node.js 22.5+，跳过此步骤。

## 2. 下载项目

```bash
git clone https://github.com/guiyuan98/oi-lan-lemon.git
cd oi-lan-lemon
npm ci
```

所有后续命令都在这个项目目录执行，不要照抄其他人的绝对路径。

## 3. 编译 Linux 版 Lemon worker

```bash
git clone --depth 1 --shallow-submodules --recursive \
  https://github.com/Project-LemonLime/Project_LemonLime.git \
  .build/Project_LemonLime

mkdir -p .build/Project_LemonLime/tools/lemon-headless bin
cp lemon-worker/main.cpp lemon-worker/CMakeLists.txt \
  .build/Project_LemonLime/tools/lemon-headless/

grep -Fq 'add_subdirectory(tools/lemon-headless)' \
  .build/Project_LemonLime/CMakeLists.txt || \
  printf '\nadd_subdirectory(tools/lemon-headless)\n' >> \
  .build/Project_LemonLime/CMakeLists.txt

cmake -S .build/Project_LemonLime \
  -B .build/Project_LemonLime/build-headless \
  -GNinja -DCMAKE_BUILD_TYPE=Release -DEMBED_DOCS=OFF

cmake --build .build/Project_LemonLime/build-headless \
  --target lemon-headless

install -m 755 \
  .build/Project_LemonLime/build-headless/tools/lemon-headless/lemon-headless \
  bin/lemon-headless
```

检查 worker 和 Bubblewrap：

```bash
./bin/lemon-headless --help
bwrap --ro-bind / / --unshare-all --die-with-parent true
```

第二条命令没有输出且退出码为 0 才算通过。如果提示不允许创建用户命名空间，说明当前内核、VPS 或容器限制了 Bubblewrap；不要绕过隔离直接运行学生程序，应更换允许非特权用户命名空间的宿主机。

## 4. 首次启动

```bash
npm run check
HOST=0.0.0.0 PORT=3000 npm start
```

教师本机访问 `http://127.0.0.1:3000`。运行 `hostname -I` 查看服务器局域网地址，学生访问 `http://服务器局域网IP:3000`。管理员令牌会显示在终端并写入 `data/admin-token.txt`。

不要使用 root 启动网站。worker 和学生程序会继承网站进程的账户权限，应使用专门的普通账户，并确保该账户无法读取教师个人文件。

## 5. 配置 systemd 自启动

先在项目目录执行以下命令。脚本会自动使用当前用户名、项目绝对路径和 Node.js 绝对路径，不需要手改成别人的目录：

```bash
PROJECT_DIR="$(pwd)"
SERVICE_USER="$(id -un)"
NODE_BIN="$(command -v node)"

sudo tee /etc/systemd/system/oi-lan-lemon.service >/dev/null <<EOF
[Unit]
Description=OI LAN Lemon Judge
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $PROJECT_DIR/server.mjs
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now oi-lan-lemon
sudo systemctl status oi-lan-lemon
```

查看日志与管理员令牌：

```bash
journalctl -u oi-lan-lemon -f
cat data/admin-token.txt
```

停止或重启：

```bash
sudo systemctl stop oi-lan-lemon
sudo systemctl restart oi-lan-lemon
```

## 6. 局域网与防火墙

只允许实际使用的局域网网段访问 TCP 3000，不要直接开放给整个互联网。例如局域网确实是 `192.168.1.0/24` 且使用 UFW 时：

```bash
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
```

不同学校的网段可能是 `10.x.x.x`、`172.16.x.x` 或其他范围，必须先向网络管理员确认，不能机械照抄示例。

## 7. 更新与备份

```bash
sudo systemctl stop oi-lan-lemon
git pull --ff-only
npm ci
sudo systemctl start oi-lan-lemon
```

如果 `lemon-worker/` 发生变化，重新执行第 3 节。比赛前后备份整个 `data/` 目录。

## 8. Linux 部署限制

- 屏幕监考客户端仍是 Windows EXE；Linux 只负责服务器和测评，学生机仍需 Windows。
- Windows 编译的特殊评测器、交互器或其他 EXE 不能在 Linux worker 中运行。传统题可以直接使用；特殊题必须准备 Linux 版程序并完整演练。
- Linux 文件名区分大小写，`Sum.cpp` 与 `sum.cpp` 不同。
- Windows 与 Linux 的编译器、计时和内存统计存在差异，不应把两个平台的测评结果混在同一场正式排名中。
- Bubblewrap 是隔离层，不等于经过安全审计的比赛级强沙箱。正式比赛仍应使用独立账户、专用机器、断网或独立 VLAN，并准备整机还原方案。

相关资料：[LemonLime Linux 构建说明](https://github.com/Project-LemonLime/Project_LemonLime/blob/master/BUILD.md)、[Debian 13 Qt 6.8 开发包](https://packages.debian.org/trixie/qt6-base-dev)、[Debian Bubblewrap 软件包](https://packages.debian.org/trixie/bubblewrap)。
