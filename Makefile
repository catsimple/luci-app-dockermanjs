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


include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
