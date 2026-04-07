include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Support for docker (js frontend)
LUCI_DEPENDS:=@(aarch64||arm||x86_64) \
	@!PACKAGE_luci-app-dockerman \
	+luci-base \
	+docker \
	+ttyd \
	+dockerd \
	+docker-compose \
	+ucode-mod-socket

PKG_LICENSE:=AGPL-3.0
PKG_MAINTAINER:=Paul Donald <newtwen+github@gmail.com> \
		Florian Eckert <fe@dev.tdt.de>

define Package/$(PKG_NAME)/preinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0

if opkg status luci-app-dockerman >/dev/null 2>&1; then
	echo "ERROR: luci-app-dockermanjs conflicts with luci-app-dockerman."
	echo "Please remove luci-app-dockerman first."
	exit 1
fi

exit 0
endef

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
