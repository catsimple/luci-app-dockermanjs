'use strict';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';
'require dockerman.common as dm2';

/*
Copyright 2026
Docker manager JS for Luci by Paul Donald <newtwen+github@gmail.com> 
Based on Docker Lua by lisaac <https://github.com/lisaac/luci-app-dockerman>
LICENSE: GPLv2.0
*/

const dummy_stats = {"read":"2026-01-08T22:57:31.547920715Z","pids_stats":{"current":3},"networks":{"eth0":{"rx_bytes":5338,"rx_dropped":0,"rx_errors":0,"rx_packets":36,"tx_bytes":648,"tx_dropped":0,"tx_errors":0,"tx_packets":8},"eth5":{"rx_bytes":4641,"rx_dropped":0,"rx_errors":0,"rx_packets":26,"tx_bytes":690,"tx_dropped":0,"tx_errors":0,"tx_packets":9}},"memory_stats":{"stats":{"total_pgmajfault":0,"cache":0,"mapped_file":0,"total_inactive_file":0,"pgpgout":414,"rss":6537216,"total_mapped_file":0,"writeback":0,"unevictable":0,"pgpgin":477,"total_unevictable":0,"pgmajfault":0,"total_rss":6537216,"total_rss_huge":6291456,"total_writeback":0,"total_inactive_anon":0,"rss_huge":6291456,"hierarchical_memory_limit":67108864,"total_pgfault":964,"total_active_file":0,"active_anon":6537216,"total_active_anon":6537216,"total_pgpgout":414,"total_cache":0,"inactive_anon":0,"active_file":0,"pgfault":964,"inactive_file":0,"total_pgpgin":477},"max_usage":6651904,"usage":6537216,"failcnt":0,"limit":67108864},"blkio_stats":{},"cpu_stats":{"cpu_usage":{"percpu_usage":[8646879,24472255,36438778,30657443],"usage_in_usermode":50000000,"total_usage":100215355,"usage_in_kernelmode":30000000},"system_cpu_usage":739306590000000,"online_cpus":4,"throttling_data":{"periods":0,"throttled_periods":0,"throttled_time":0}},"precpu_stats":{"cpu_usage":{"percpu_usage":[8646879,24350896,36438778,30657443],"usage_in_usermode":50000000,"total_usage":100093996,"usage_in_kernelmode":30000000},"system_cpu_usage":9492140000000,"online_cpus":4,"throttling_data":{"periods":0,"throttled_periods":0,"throttled_time":0}}};

// https://docs.docker.com/reference/api/engine/version/v1.47/#tag/Container/operation/ContainerStats
// Helper function to calculate memory usage percentage
function calculateMemoryUsage(stats) {
	if (!stats || !stats.memory_stats) return null;
	const mem = stats.memory_stats;
	if (!mem.usage || !mem.limit) return null;

	// used_memory = memory_stats.usage - memory_stats.stats.cache
	const cache = mem.stats?.cache || 0;
	const used_memory = mem.usage - cache;
	const available_memory = mem.limit;

	// Memory usage % = (used_memory / available_memory) * 100.0
	const percentage = (used_memory / available_memory) * 100.0;

	return {
		percentage: percentage,
		used: used_memory,
		limit: available_memory
	};
}

// Helper function to calculate CPU usage percentage
// Pass previousStats if Docker API doesn't provide complete precpu_stats
function calculateCPUUsage(stats, previousStats) {
	if (!stats || !stats.cpu_stats) return null;
	const cpu = stats.cpu_stats;

	// Try to use precpu_stats from API first, fall back to our stored previous stats
	let precpu = stats.precpu_stats;

	// If precpu_stats is incomplete, use our manually stored previous stats
	if (!precpu || !precpu.system_cpu_usage) {
		if (previousStats && previousStats.cpu_stats) {
			// console.log('Using manually stored previous CPU stats');
			precpu = previousStats.cpu_stats;
		} else {
			// console.log('No previous CPU stats available yet - waiting for next cycle');
			return null;
		}
	}

	// If we don't have both cpu_stats and precpu_stats, return null
	if (!cpu.cpu_usage || !precpu || !precpu.cpu_usage) {
		// console.log('CPU stats incomplete:', { 
		// 	hasCpu: !!cpu.cpu_usage, 
		// 	hasPrecpu: !!precpu,
		// 	hasPrecpuUsage: !!(precpu && precpu.cpu_usage)
		// });
		return null;
	}

	// Validate we have the required fields
	const validationChecks = {
		'cpu.cpu_usage.total_usage': typeof cpu.cpu_usage.total_usage,
		'precpu.cpu_usage.total_usage': typeof precpu.cpu_usage.total_usage,
		'cpu.system_cpu_usage': typeof cpu.system_cpu_usage,
		'precpu.system_cpu_usage': typeof precpu.system_cpu_usage,
		'cpu_values': {
			cpu_total: cpu.cpu_usage.total_usage,
			precpu_total: precpu.cpu_usage.total_usage,
			cpu_system: cpu.system_cpu_usage,
			precpu_system: precpu.system_cpu_usage
		}
	};

	// Check if we have valid numeric values for all required fields
	// Note: precpu_stats may be empty/undefined on first stats call
	if (typeof cpu.cpu_usage.total_usage !== 'number' || 
		typeof precpu.cpu_usage.total_usage !== 'number' ||
		typeof cpu.system_cpu_usage !== 'number' ||
		typeof precpu.system_cpu_usage !== 'number') {
		// console.log('CPU stats incomplete - waiting for valid precpu data:', validationChecks);
		return null;
	}

	// Also check if precpu data is essentially zero (first call scenario)
	if (precpu.cpu_usage.total_usage === 0 || precpu.system_cpu_usage === 0) {
		// console.log('CPU precpu stats are zero - waiting for next stats cycle');
		return null;
	}

	// cpu_delta = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage
	const cpu_delta = cpu.cpu_usage.total_usage - precpu.cpu_usage.total_usage;

	// system_cpu_delta = cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage
	const system_cpu_delta = cpu.system_cpu_usage - precpu.system_cpu_usage;

	// Validate deltas
	if (system_cpu_delta <= 0 || cpu_delta < 0) {
		// console.warn('Invalid CPU deltas:', { 
		// 	cpu_delta, 
		// 	system_cpu_delta,
		// 	cpu_total: cpu.cpu_usage.total_usage,
		// 	precpu_total: precpu.cpu_usage.total_usage,
		// 	system: cpu.system_cpu_usage,
		// 	presystem: precpu.system_cpu_usage
		// });
		return null;
	}

	// number_cpus = length(cpu_stats.cpu_usage.percpu_usage) or cpu_stats.online_cpus
	const number_cpus = cpu.online_cpus || (cpu.cpu_usage.percpu_usage?.length || 1);

	// CPU usage % = (cpu_delta / system_cpu_delta) * number_cpus * 100.0
	const percentage = (cpu_delta / system_cpu_delta) * number_cpus * 100.0;

	// console.log('CPU calculation:', { 
	// 	cpu_delta, 
	// 	system_cpu_delta, 
	// 	number_cpus, 
	// 	percentage: percentage.toFixed(2) + '%'
	// });

	return {
		percentage: percentage,
		number_cpus: number_cpus
	};
}

// Helper function to create a progress bar
function createProgressBar(label, percentage, used, total) {
	const clampedPercentage = Math.min(Math.max(percentage || 0, 0), 100);
	const color = clampedPercentage > 90 ? '#d9534f' : (clampedPercentage > 70 ? '#f0ad4e' : '#5cb85c');
	const detailText = (used && total) ? `${used} / ${total}` : `${clampedPercentage.toFixed(2)}%`;

	return E('div', { 'style': 'margin: 10px 0;' }, [
		E('div', { 'style': 'display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 6px; gap: 2px;' }, [
			E('span', { 'style': 'font-weight: bold;' }, label),
			E('span', { 'style': 'text-align: left; white-space: normal; overflow-wrap: anywhere;' }, detailText)
		]),
		E('div', { 
			'style': 'width: 100%; max-width: 640px; height: 20px; background-color: #e9ecef; border-radius: 4px; overflow: hidden;'
		}, [
			E('div', {
				'style': `width: ${clampedPercentage}%; height: 100%; background-color: ${color}; transition: width 0.3s ease;`
			})
		])
	]);
}


return dm2.dv.extend({
	load() {
		const requestPath = L.env.requestpath;
		const containerId = requestPath[requestPath.length-1] || '';
		this.psArgs = uci.get('dockerd', 'globals', 'ps_flags') || '-ww';

		// First load container info to check state
		return dm2.container_inspect({id: containerId})
			.then(container => {
				if (container.code !== 200) window.location.href = `${this.dockerman_url}/containers`;
				const this_container = container.body || {};

				// Preload only essential data for fast page open.

				return Promise.all([
					this_container,
					Promise.resolve([]),
					dm2.network_list().then(networks => {
						return Array.isArray(networks.body) ? networks.body : [];
					}),
					dm2.docker_info().then(info => {
						const numcpus = info.body?.NCPU || 1.0;
						const memory = info.body?.MemTotal || 2**10;
						return {numcpus: numcpus, memory: memory};
					}),
					Promise.resolve(null),
					Promise.resolve(null),
				]);
			});
	},

	buildList(array, mapper) {
		if (!Array.isArray(array)) return [];
		const out = [];
		for (const item of array) {
			const mapped = mapper(item);
			if (mapped || mapped === 0)
				out.push(mapped);
		}
		return out;
	},

	buildListFromObject(obj, mapper) {
		if (!obj || typeof obj !== 'object') return [];
		const out = [];
		for (const [k, v] of Object.entries(obj)) {
			const mapped = mapper(k, v);
			if (mapped || mapped === 0)
				out.push(mapped);
		}
		return out;
	},

	getMountsList(this_container) {
		return this.buildList(this_container?.Mounts, (mount) => {
			if (!mount?.Type || !mount?.Destination) return null;
			let entry = `${mount.Type}:${mount.Source}:${mount.Destination}`;
			if (mount.Mode) entry += `:${mount.Mode}`;
			return entry;
		});
	},

	getPortsList(this_container) {
		const portBindings = this_container?.HostConfig?.PortBindings;
		if (!portBindings || typeof portBindings !== 'object') return [];
		const ports = [];
		for (const [containerPort, bindings] of Object.entries(portBindings)) {
			if (Array.isArray(bindings) && bindings.length > 0 && bindings[0]?.HostPort) {
				ports.push(`${bindings[0].HostPort}:${containerPort}`);
			}
		}
		return ports;
	},

	getEnvList(this_container) {
		return this_container?.Config?.Env || [];
	},

	getDevicesList(this_container) {
		return this.buildList(this_container?.HostConfig?.Devices, (device) => {
			if (!device?.PathOnHost || !device?.PathInContainer) return null;
			let entry = `${device.PathOnHost}:${device.PathInContainer}`;
			if (device.CgroupPermissions) entry += `:${device.CgroupPermissions}`;
			return entry;
		});
	},

	getTmpfsList(this_container) {
		return this.buildListFromObject(this_container?.HostConfig?.Tmpfs, (path, opts) => `${path}${opts ? ':' + opts : ''}`);
	},

	getDnsList(this_container) {
		return this_container?.HostConfig?.Dns || [];
	},

	getSysctlList(this_container) {
		return this.buildListFromObject(this_container?.HostConfig?.Sysctls, (key, value) => `${key}:${value}`);
	},

	getCapAddList(this_container) {
		return this_container?.HostConfig?.CapAdd || [];
	},

	getLogOptList(this_container) {
		return this.buildListFromObject(this_container?.HostConfig?.LogConfig?.Config, (key, value) => `${key}=${value}`);
	},

	getCNetworksArray(c_networks, networks) {
		if (!c_networks || typeof c_networks !== 'object') return [];
		const data = [];

		for (const [name, net] of Object.entries(c_networks)) {
			const network = networks.find(n => n.Name === name || n.Id === name);
			const netid = !net?.NetworkID ? network?.Id : net?.NetworkID;

			/* Even if netid is null, proceed: perhaps the network was deleted. If we
			display it, the user can disconnect it. */
			data.push({
				...net,
				_shortId: netid?.substring(0,12) ||  '',
				Name: name,
				NetworkID: netid,
				DNSNames: net?.DNSNames || '',
				IPv4Address: net?.IPAMConfig?.IPv4Address || '',
				IPv6Address: net?.IPAMConfig?.IPv6Address || '',
			});
		}

		return data;
	},

	render([this_container, _images, networks, cpus_mem, ps_top, stats_data]) {
		const view = this;
		const containerName = this_container.Name?.substring(1) || this_container.Id || '';
		const containerIdShort = (this_container.Id || '').substring(0, 12);
		const c_networks = this_container.NetworkSettings?.Networks || {};
		this.container = this_container;
		this.containerId = this_container.Id;
		this.networks = Array.isArray(networks) ? networks : [];
		this.logsAutoRefreshEnabled = (this.logsAutoRefreshEnabled === true);
		this.logsRefreshIntervalSeconds = Number(this.logsRefreshIntervalSeconds || 5);
		if (Number.isNaN(this.logsRefreshIntervalSeconds) || this.logsRefreshIntervalSeconds < 2)
			this.logsRefreshIntervalSeconds = 5;
		this.logsRefreshIntervalSeconds = Math.min(300, this.logsRefreshIntervalSeconds);
		this.logsFontSizePx = Number(this.logsFontSizePx || 12);
		if (Number.isNaN(this.logsFontSizePx))
			this.logsFontSizePx = 12;
		this.logsFontSizePx = Math.min(24, Math.max(10, this.logsFontSizePx));
		this.logsLoadPending = false;
		this.statsLoadedOnce = false;
		this.statsLoadPending = false;
		this.psLoadedOnce = false;
		this.psLoadPending = false;
		this.inspectLoadedOnce = false;
		this.inspectLoadPending = false;
		this.stopLogsAutoRefresh();
		if (!document.getElementById('dockerman-container-detail-style')) {
			const style = document.createElement('style');
			style.id = 'dockerman-container-detail-style';
			style.textContent = `
.dockerman-container-detail .cbi-map .cbi-section-node {
	margin-left: 0 !important;
	margin-right: 0 !important;
	max-width: none !important;
}
.dockerman-container-detail .cbi-map {
	margin-left: 0 !important;
	margin-right: 0 !important;
	max-width: none !important;
}
.dockerman-container-detail .cbi-section {
	margin-left: 0 !important;
	margin-right: 0 !important;
	max-width: none !important;
}
.dockerman-container-detail .cbi-tabcontainer[data-tab],
.dockerman-container-detail .cbi-tabcontainer[id] {
	padding: 14px 18px 18px;
}
.dockerman-container-detail .cbi-tabcontainer[data-tab] .cbi-section,
.dockerman-container-detail .cbi-tabcontainer[id] .cbi-section {
	margin: 0 0 14px 0;
}
.dockerman-container-detail [id="container.json.cont.info"] {
	display: block;
	width: 100%;
	margin: 0 !important;
	padding: 0 12px;
	box-sizing: border-box;
}
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value {
	display: grid !important;
	grid-template-columns: minmax(150px, 33%) minmax(0, 1fr);
	align-items: start;
	column-gap: 12px;
	padding: 10px 0;
	border-bottom: 1px solid #dfe4ec;
}
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-title,
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-field {
	display: block !important;
	float: none !important;
	clear: none !important;
	margin: 0 !important;
	text-align: left !important;
	vertical-align: top;
	padding: 0 !important;
}
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-title {
	font-weight: 600;
	color: #1f2a44;
}
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-field {
	min-width: 0;
	margin-left: 0 !important;
	overflow-wrap: anywhere;
	word-break: break-word;
}
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-field input,
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-field select,
.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-field textarea {
	max-width: 640px;
}
.dockerman-container-detail #stats-progress-bars {
	max-width: 760px;
}
.dockerman-container-detail #raw-stats-field,
.dockerman-container-detail #raw-ps-field {
	margin-top: 8px;
	padding: 12px;
	border: 1px solid #d9dee7;
	border-radius: 6px;
	background: #fff;
}
@media (max-width: 900px) {
	.dockerman-container-detail [id="container.json.cont.info"] {
		display: block;
		padding: 0 8px;
	}
	.dockerman-container-detail [id="container.json.cont.info"] .cbi-value {
		display: block !important;
		padding: 8px 0;
		border-bottom: 1px solid #e7ebf3;
	}
	.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-title,
	.dockerman-container-detail [id="container.json.cont.info"] .cbi-value .cbi-value-field {
		display: block;
		width: 100%;
		padding: 4px 0;
		border-bottom: 0;
	}
}
`;
			document.head.appendChild(style);
		}

		// Create main container with action buttons
		const mainContainer = E('div', { 'class': 'dockerman-container-detail' });
		const tabSectionPad = 'padding: 12px 16px 16px;';

		const containerStatus = this.getContainerStatus(this_container);

		// Add title and description
		const header = E('div', { 'class': 'cbi-page' }, [
			E('h2', {}, _('Docker - Container')),
			E('p', { 'style': 'margin: 10px 0; display: flex; gap: 6px; align-items: center;' }, [
				this.wrapStatusText(containerName, containerStatus, 'font-weight:600;'),
				E('span', { 'style': 'color:#666;' }, `(${containerIdShort})`)
			]),
			E('p', { 'style': 'color: #666;' }, _('Manage and view container configuration'))
		]);
		mainContainer.appendChild(header);

		// Add action buttons section
		const buttonSection = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 20px;' });
		const buttonContainer = E('div', { 'style': 'display: flex; gap: 10px; flex-wrap: wrap;' });

		// Start button
		if (containerStatus !== 'running') {
			const startBtn = E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': (ev) => this.executeAction(ev, 'start', this_container.Id)
			}, [_('Start')]);
			buttonContainer.appendChild(startBtn);
		}

		// Restart button
		if (containerStatus === 'running') {
			const restartBtn = E('button', {
				'class': 'cbi-button cbi-button-reload',
				'click': (ev) => this.executeAction(ev, 'restart', this_container.Id)
			}, [_('Restart')]);
			buttonContainer.appendChild(restartBtn);
		}

		// Stop button
		if (containerStatus === 'running' || containerStatus === 'paused') {
			const stopBtn = E('button', {
				'class': 'cbi-button cbi-button-reset',
				'click': (ev) => this.executeAction(ev, 'stop', this_container.Id)
			}, [_('Stop')]);
			buttonContainer.appendChild(stopBtn);
		}

		// Kill button
		if (containerStatus === 'running') {
			const killBtn = E('button', {
				'class': 'cbi-button',
				'style': 'background-color: #dc3545;',
				'click': (ev) => this.executeAction(ev, 'kill', this_container.Id)
			}, [_('Kill')]);
			buttonContainer.appendChild(killBtn);
		}

		// Pause/Unpause button
		if (containerStatus === 'running' || containerStatus === 'paused') {
			const isPausedNow = this.container?.State?.Paused === true;
			const pauseBtn = E('button', {
				'class': 'cbi-button',
				'id': 'pause-button',
				'click': (ev) => {
					const currentStatus = this.getContainerStatus(this_container);
					this.executeAction(ev, (currentStatus === 'paused' ? 'unpause' : 'pause'), this_container.Id);
				}
			}, [isPausedNow ? _('Unpause') : _('Pause')]);
			buttonContainer.appendChild(pauseBtn);
		}

		// Update config button
		const updateCfgBtn = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'click': (ev) => this.handleSave(ev),
		}, [_('Update')]);
		buttonContainer.appendChild(updateCfgBtn);

		// Upgrade button (pull latest image + recreate)
		const upgradeBtn = E('button', {
			'class': 'cbi-button cbi-button-reload',
			'click': (ev) => this.upgradeContainer(ev, this_container),
		}, [_('Upgrade')]);
		buttonContainer.appendChild(upgradeBtn);

		// Duplicate button
		const duplicateBtn = E('button', {
			'class': 'cbi-button cbi-button-add',
			'click': (ev) => {
				ev.preventDefault();
				window.location.href = `${this.dockerman_url}/container_new/duplicate/${this_container.Id}`;
			}
		}, [_('Duplicate/Edit')]);
		buttonContainer.appendChild(duplicateBtn);

		// Export button
		const exportBtn = E('button', {
			'class': 'cbi-button cbi-button-reload',
			'click': (ev) => {
				ev.preventDefault();
				window.location.href = `${this.dockerman_url}/container/export/${this_container.Id}`;
			}
		}, [_('Export')]);
		buttonContainer.appendChild(exportBtn);

		// Remove button
		const removeBtn = E('button', {
			'class': 'cbi-button cbi-button-remove',
			'click': (ev) => this.executeAction(ev, 'remove', this_container.Id),
		}, [_('Remove')]);
		buttonContainer.appendChild(removeBtn);

		// Back button
		const backBtn = E('button', {
			'class': 'cbi-button',
			'click': () => window.location.href = `${this.dockerman_url}/containers`,
		}, [_('Back to Containers')]);
		buttonContainer.appendChild(backBtn);

		buttonSection.appendChild(buttonContainer);
		mainContainer.appendChild(buttonSection);


		const m = new form.JSONMap({
			cont: this_container,
			nets: this.getCNetworksArray(c_networks, networks),
			hostcfg: this_container.HostConfig || {},
		}, null);
		m.submit = false;
		m.reset = false;

		let s = m.section(form.NamedSection, 'cont', null, _('Container detail'));
		s.anonymous = true;
		s.nodescriptions = true;
		s.addremove = false;

		let o, ss;

		s.tab('info', _('Info'));

		o = s.taboption('info', form.Value, 'Name', _('Name'));
		o.cfgvalue = (sid) => {
			const name = this.map.data.data[sid]?.Name || '';
			return String(name).replace(/^\//, '');
		};
		o.write = function(sid, value) {
			this.map.data.data[sid].Name = String(value || '').replace(/^\//, '');
		};

		o = s.taboption('info', form.DummyValue, 'Id', _('ID'));

		o = s.taboption('info', form.DummyValue, 'Image', _('Image'));
		o.cfgvalue = () => this_container.Config?.Image || '-';

		o = s.taboption('info', form.DummyValue, 'Image', _('Image ID'));

		o = s.taboption('info', form.DummyValue, 'status', _('Status'));
		o.cfgvalue = (sid) => this.map.data.data[sid].State?.Status || '';

		o = s.taboption('info', form.DummyValue, 'Created', _('Created'));

		o = s.taboption('info', form.DummyValue, 'started', _('Finish Time'));
		o.cfgvalue = () => {
			if (this_container.State?.Running)
				return this_container.State?.StartedAt || '-';
			return this_container.State?.FinishedAt || '-';
		};

		o = s.taboption('info', form.DummyValue, 'healthy', _('Health Status'));
		o.cfgvalue = () => this_container.State?.Health?.Status || '-';

		o = s.taboption('info', form.DummyValue, 'user', _('User'));
		o.cfgvalue = () => this_container.Config?.User || '-';

		o = s.taboption('info', form.ListValue, 'restart_policy', _('Restart Policy'));
		o.cfgvalue = () => this_container.HostConfig?.RestartPolicy?.Name || '-';
		o.value('no', _('No'));
		o.value('unless-stopped', _('Unless stopped'));
		o.value('always', _('Always'));
		o.value('on-failure', _('On failure'));

		o = s.taboption('info', form.DummyValue, 'hostname', _('Host Name'));
		o.cfgvalue = () => this_container.Config?.Hostname || '-';

		o = s.taboption('info', form.DummyValue, 'command', _('Command'));
		o.cfgvalue = () => {
			const cmd = this_container.Config?.Cmd;
			if (Array.isArray(cmd))
				return cmd.join(' ');
			return cmd || '-';
		};

		o = s.taboption('info', form.DummyValue, 'env', _('Env'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const env = this.getEnvList(this_container);
			return env.length > 0 ? env.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'ports', _('Ports'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const ports = view.getPortsList(this_container);
			return ports.length > 0 ? ports.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'links', _('Links'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const links = this_container.HostConfig?.Links;
			return Array.isArray(links) && links.length > 0 ? links.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'devices', _('Devices'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const devices = this.getDevicesList(this_container);
			return devices.length > 0 ? devices.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'tmpfs', _('Tmpfs Directories'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const tmpfs = this.getTmpfsList(this_container);
			return tmpfs.length > 0 ? tmpfs.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'dns', _('DNS'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const dns = view.getDnsList(this_container);
			return dns.length > 0 ? dns.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'sysctl', _('Sysctl Settings'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const sysctl = this.getSysctlList(this_container);
			return sysctl.length > 0 ? sysctl.join('<br />') : '-';
		};

		o = s.taboption('info', form.DummyValue, 'mounts', _('Mounts/Binds'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const mounts = view.getMountsList(this_container);
			return mounts.length > 0 ? mounts.join('<br />') : '-';
		};

		// NETWORKS TAB
		s.tab('network', _('Networks'));

		o = s.taboption('network', form.SectionValue, '__net__', form.TableSection, 'nets', null);
		ss = o.subsection;
		ss.anonymous = true;
		ss.nodescriptions = true;
		ss.addremove = true;
		ss.addbtntitle = _('Connect') + ' 🔗';
		ss.delbtntitle = _('Disconnect') + ' ⛓️‍💥';

		o = ss.option(form.DummyValue, 'Name', _('Name'));

		o = ss.option(form.DummyValue, '_shortId', _('ID'));
		o.cfgvalue = function(section_id, value) {
			const name_links = false;
			const nets = this.map.data.data[section_id] || {};
			return view.parseNetworkLinksForContainer(networks, (Array.isArray(nets) ? nets : [nets]), name_links);
		};

		o = ss.option(form.DummyValue, 'IPv4Address', _('IPv4 Address'));

		o = ss.option(form.DummyValue, 'IPv6Address', _('IPv6 Address'));

		o = ss.option(form.DummyValue, 'GlobalIPv6Address', _('Global IPv6 Address'));

		o = ss.option(form.DummyValue, 'MacAddress', _('MAC Address'));

		o = ss.option(form.DummyValue, 'Gateway', _('Gateway'));

		o = ss.option(form.DummyValue, 'IPv6Gateway', _('IPv6 Gateway'));

		o = ss.option(form.DummyValue, 'DNSNames', _('DNS Names'));

		ss.handleAdd = function(ev) {
			ev.preventDefault();
			view.executeNetworkAction('connect', null, null, this_container);
		};

		ss.handleRemove = function(section_id, ev) {
			const network = this.map.data.data[section_id];
			ev.preventDefault();
			delete this.map.data.data[section_id];
			this.super('handleRemove', [ev]);
			view.executeNetworkAction('disconnect', (network.NetworkID || network.Name), network.Name, this_container);
		};



		s.tab('resources', _('Resources'));

		o = s.taboption('resources', form.SectionValue, '__hcfg__', form.TypedSection, 'hostcfg', null);
		ss = o.subsection;
		ss.anonymous = true;
		ss.nodescriptions = false;
		ss.addremove = false;

		o = ss.option(form.Value, 'NanoCpus', _('CPUs'));
		o.cfgvalue = (sid) => view.map.data.data[sid].NanoCpus / (10**9);
		o.placeholder='1.5';
		o.description = _('Example: 1.5 (fractional CPU cores)');
		o.datatype = 'ufloat';
		o.validate = function(section_id, value) {
			if (!value) return true;
			if (value > cpus_mem.numcpus) return _(`Only ${cpus_mem.numcpus} CPUs available`);
			return true;
		};

		o = ss.option(form.Value, 'CpuPeriod', _('CPU Period (microseconds)'));
		o.placeholder = '100000';
		o.description = _('Range: 1000-1000000, unit is microseconds');
		o.datatype = 'or(and(uinteger,min(1000),max(1000000)),"0")';

		o = ss.option(form.Value, 'CpuQuota', _('CPU Quota (microseconds)'));
		o.placeholder = '0';
		o.description = _('Example: 50000, 0 means no explicit quota');
		o.datatype = 'uinteger';

		o = ss.option(form.Value, 'CpuShares', _('CPU Shares Weight'));
		o.placeholder='1024';
		o.description = _('Relative weight, commonly 2-262144 (default 1024)');
		o.datatype = 'uinteger';

		o = ss.option(form.Value, 'Memory', _('Memory Limit'));
		o.cfgvalue = (sid, val) => {
			const mem = view.map.data.data[sid].Memory;
			return mem ? view.formatBytesSI(mem) : '0 B';
		};
		o.placeholder = '4GB';
		o.description = _('Examples: 512MB, 4GB, 1.5G, 512MiB, 1GiB');
		o.write = function(sid, val) {
			if (!val || val == 0) return 0;
			const input = String(val).trim();
			const current = Number(this.map.data.data[sid].Memory || 0);
			if (input === view.formatBytesSI(current))
				return current;
			const parsed = view.parseMemory(input);
			this.map.data.data[sid].Memory = parsed;
			return parsed || 0;
		};
		o.validate = function(sid, value) {
			if (!value) return true;
			const parsed = view.parseMemory(value);
			if (parsed > view.memory) return _('Only %s available').format(view.formatBytesSI(view.memory));
			return true;
		};

		o = ss.option(form.Value, 'MemorySwap', _('Memory + Swap'));
		o.cfgvalue = (sid, val) => {
			const swap = this.map.data.data[sid].MemorySwap;
			return (swap === -1) ? '-1' : (swap ? view.formatBytesSI(swap) : '0 B');
		};
		o.placeholder = '-1';
		o.description = _('Examples: -1 (unlimited), 8GB, 8192M, 8GiB');
		o.write = function(sid, val) {
			if (!val || val == 0) return 0;
			const input = String(val).trim();
			const current = this.map.data.data[sid].MemorySwap;
			if (input === '-1' || input === '-1 (unlimited)') {
				this.map.data.data[sid].MemorySwap = -1;
				return -1;
			}
			if (Number(current) > 0 && input === view.formatBytesSI(current))
				return Number(current);
			const parsed = view.parseMemory(input);
			this.map.data.data[sid].MemorySwap = parsed;
			return parsed || 0;
		};

		o = ss.option(form.Value, 'MemoryReservation', _('Memory Reservation'));
		o.cfgvalue = (sid, val) => {
			const res = this.map.data.data[sid].MemoryReservation;
			return res ? view.formatBytesSI(res) : '0 B';
		};
		o.placeholder = '2GB';
		o.description = _('Examples: 256MB, 2GB, 2GiB');
		o.write = function(sid, val) {
			if (!val || val == 0) return 0;
			const input = String(val).trim();
			const current = Number(this.map.data.data[sid].MemoryReservation || 0);
			if (input === view.formatBytesSI(current))
				return current;
			const parsed = view.parseMemory(input);
			this.map.data.data[sid].MemoryReservation = parsed;
			return parsed || 0;
		};

		o = ss.option(form.Flag, 'OomKillDisable', _('OOM Kill Disable'));

		o = ss.option(form.Value, 'BlkioWeight', _('Block IO Weight'));
		o.datatype = 'and(uinteger,min(0),max(1000)';

		o = ss.option(form.DummyValue, 'Privileged', _('Privileged Mode'));
		o.cfgvalue = (sid, val) => this.map.data.data[sid]?.Privileged ? _('Yes') : _('No');

		o = ss.option(form.DummyValue, 'CapAdd', _('Added Capabilities'));
		o.cfgvalue = (sid, val) => {
			const caps = this.map.data.data[sid]?.CapAdd;
			return Array.isArray(caps) && caps.length > 0 ? caps.join(', ') : '-';
		};

		o = ss.option(form.DummyValue, 'CapDrop', _('Dropped Capabilities'));
		o.cfgvalue = (sid, val) => {
			const caps = this.map.data.data[sid]?.CapDrop;
			return Array.isArray(caps) && caps.length > 0 ? caps.join(', ') : '-';
		};

		o = ss.option(form.DummyValue, 'LogDriver', _('Log Driver'));
		o.cfgvalue = (sid) => this.map.data.data[sid].LogConfig?.Type || '-';

		o = ss.option(form.DummyValue, 'log_opt', _('Log Options'));
		o.cfgvalue = () => {
			const opts = this.getLogOptList(this_container);
			return opts.length > 0 ? opts.join('<br />') : '-';
		};

		// STATS TAB
		s.tab('stats', _('Stats'));

		function updateStats(stats_data) {
			const status = view.getContainerStatus(this_container);

			if (status !== 'running') {
				// If we already have UI elements, clear/update them
				if (view.statsTable) {
					const progressBarsSection = document.getElementById('stats-progress-bars');
					if (progressBarsSection) {
						progressBarsSection.innerHTML = '';
						progressBarsSection.appendChild(E('p', {}, _('Container is not running') + ' (' + _('Status') + ': ' + status + ')'));
					}
					try { view.statsTable.update([]); } catch (e) {}
				}

				return E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
					E('p', {}, [
						_('Container is not running') + ' (' + _('Status') + ': ' + status + ')'
					])
				]);
			}

			if (!stats_data && view.statsTable)
				return true;

			const stats = stats_data || null;

			// Calculate usage percentages
			const memUsage = calculateMemoryUsage(stats);
			const cpuUsage = calculateCPUUsage(stats, view.previousCpuStats);

			// Store current stats for next calculation
			view.previousCpuStats = stats;

			// Prepare rows
			const rows = stats ? [
				[_('PID Stats'), view.objectToText(stats.pids_stats)],
				[_('Net Stats'), view.objectToText(stats.networks)],
				[_('Mem Stats'), view.objectToText(stats.memory_stats)],
				[_('BlkIO Stats'), view.objectToText(stats.blkio_stats)],
				[_('CPU Stats'), view.objectToText(stats.cpu_stats)],
				[_('Per CPU Stats'), view.objectToText(stats.precpu_stats)]
			] : [];

			// If table already exists (polling update), update in-place
			if (view.statsTable) {
				try {
					view.statsTable.update(rows);
				} catch (e) { console.error('Failed to update stats table', e); }

				// Update progress bars
				const progressBarsSection = document.getElementById('stats-progress-bars');
				if (progressBarsSection) {
					progressBarsSection.innerHTML = '';
					progressBarsSection.appendChild(E('h3', {}, _('Resource Usage')));
					if (!stats) {
						progressBarsSection.appendChild(E('div', {}, _('Stats not loaded yet. Click Refresh.')));
					}
					else {
						progressBarsSection.appendChild(
							memUsage ? createProgressBar(
								_('Memory Usage'),
								memUsage.percentage,
								view.formatBytesSI(memUsage.used),
								view.formatBytesSI(memUsage.limit)
							) : E('div', {}, _('Memory usage data unavailable'))
						);
						progressBarsSection.appendChild(
							cpuUsage ? createProgressBar(
								_('CPU Usage') + ` (${cpuUsage.number_cpus} CPUs)`,
								cpuUsage.percentage,
								null,
								null
							) : E('div', {}, _('CPU usage data unavailable'))
						);
					}
				}

				// Update raw JSON field
				const statsField = document.getElementById('raw-stats-field');
				if (statsField) statsField.textContent = JSON.stringify(stats || {}, null, 2);

				return true;
			}

			// Create progress bars section (initial render)
			const progressBarsSection = E('div', { 
				'class': 'cbi-section',
				'id': 'stats-progress-bars',
				'style': 'margin: 0 0 20px 0; max-width: 760px;'
			}, [
				E('h3', {}, _('Resource Usage')),
				!stats ? E('div', {}, _('Stats not loaded yet. Click Refresh.')) : (
					memUsage ? createProgressBar(
						_('Memory Usage'),
						memUsage.percentage,
						view.formatBytesSI(memUsage.used),
						view.formatBytesSI(memUsage.limit)
					) : E('div', {}, _('Memory usage data unavailable'))
				),
				!stats ? E('div') : (
					cpuUsage ? createProgressBar(
						_('CPU Usage') + ` (${cpuUsage.number_cpus} CPUs)`,
						cpuUsage.percentage,
						null,
						null
					) : E('div', {}, _('CPU usage data unavailable'))
				)
			]);

			const statsTable = new L.ui.Table(
				[_('Metric'), _('Value')],
				{ id: 'stats-table' },
				E('em', [_('No statistics available')])
			);

			// Store table reference for poll updates
			view.statsTable = statsTable;

			// Initial data
			if (rows.length > 0)
				statsTable.update(rows);

			return E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
				progressBarsSection,
				statsTable.render(),
				E('h3', { 'style': 'margin-top: 20px;' }, _('Raw JSON')),
				E('pre', { 
					style: 'overflow-x: auto; white-space: pre-wrap; word-wrap: break-word;', 
					id: 'raw-stats-field' 
				}, JSON.stringify(stats || {}, null, 2))
			]);
		};
		this.updateStatsView = updateStats;

		o = s.taboption('stats', form.DummyValue, '_stats_controls', _('Actions'));
		o.render = L.bind(() => E('div', { 'class': 'cbi-section', 'style': 'margin: 0 0 10px 0; padding: 12px 16px 0 16px;' }, [
			E('button', {
				'class': 'cbi-button cbi-button-neutral',
				'click': () => this.refreshStatsData(this_container.Id)
			}, _('Refresh'))
		]), this);

		// Create custom table for stats using L.ui.Table
		o = s.taboption('stats', form.DummyValue, '_stats_table', _('Container Statistics'));
		o.render = L.bind(() => { return updateStats(stats_data)}, this);

		// PROCESS TAB
		s.tab('ps', _('Processes'));

		// Create custom table for processes using L.ui.Table
		o = s.taboption('ps', form.DummyValue, '_ps_table', _('Running Processes'));
		o.render = L.bind(() => {
			const status = this.getContainerStatus(this_container);

			if (status !== 'running') {
				return E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
					E('p', {}, [
						_('Container is not running') + ' (' + _('Status') + ': ' + status + ')'
					])
				]);
			}

			// Use titles from the loaded data, or fallback to default
			const titles = (ps_top && ps_top.Titles) ? ps_top.Titles : 
				[_('PID'), _('USER'), _('VSZ'), _('STAT'), _('COMMAND')];

			// Store raw titles (without translation) for comparison in poll
			this.psTitles = titles;

			const psTable = new L.ui.Table(
				titles.map(t => _(t)),
				{ id: 'ps-table' },
				E('em', [_('No processes running')])
			);

			// Store table reference and titles for poll updates
			this.psTable = psTable;
			this.psTitles = titles;

			// Initial data if already available
			if (ps_top && ps_top.Processes) {
				psTable.update(ps_top.Processes);
			}

			return E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
				E('div', { 'style': 'margin-bottom: 10px;' }, [
					E('label', { 'for': 'ps-flags-input', 'style': 'margin-right: 8px;' }, _('ps flags:')),
					E('input', {
						id: 'ps-flags-input',
						'class': 'cbi-input-text',
						'type': 'text',
						'value': this.psArgs || '-ww',
						'placeholder': '-ww',
						'style': 'width: 200px;',
						'input': (ev) => { this.psArgs = ev.target.value || '-ww'; }
					}),
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'style': 'margin-left: 8px;',
						'click': () => this.refreshProcessTable(this_container.Id)
					}, _('Refresh'))
				]),
				psTable.render(),
				E('h3', { 'style': 'margin-top: 20px;' }, _('Raw JSON')),
				E('pre', { 
					style: 'overflow-x: auto; white-space: pre-wrap; word-wrap: break-word;', 
					id: 'raw-ps-field' 
				}, JSON.stringify(ps_top || {}, null, 2))
			]);
		}, this);

		// FILE TAB
		s.tab('file', _('File'));
		let fileDiv = null;

		o = s.taboption('file', form.DummyValue, 'json', '_file');
		o.cfgvalue = (sid, val) => '/';
		o.render = L.bind(() => {
			if (fileDiv) {
				return fileDiv;
			}

			fileDiv = E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
				E('div', { 'style': 'margin-bottom: 10px;' }, [
					E('label', { 'style': 'margin-right: 10px;' }, _('Path:')),
					E('input', {
						'type': 'text',
						'id': 'file-path',
						'class': 'cbi-input-text',
						'value': '/',
						'style': 'width: 200px;'
					}),
					E('button', {
						'class': 'cbi-button cbi-button-positive',
						'style': 'margin-left: 10px;',
						'click': () => this.handleFileUpload(this_container.Id),
					}, _('Upload') + ' ⬆️'),
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'style': 'margin-left: 5px;',
						'click': () => this.handleFileDownload(this_container.Id),
					}, _('Download') + ' ⬇️'),
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'style': 'margin-left: 5px;',
						'click': () => this.handleInfoArchive(this_container.Id),
					}, _('Inspect') + ' 🔎'),
				]),
				E('textarea', {
					'id': 'container-file-text',
					'readonly': true,
					'rows': '5',
					'style': 'width: 100%; font-family: monospace; font-size: 12px; padding: 10px; border: 1px solid #ccc;'
				}, '')
			]);

			return fileDiv;
		}, this);


		// INSPECT TAB
		s.tab('inspect', _('Inspect'));
		let inspectDiv = null;

		o = s.taboption('inspect', form.Button, 'json', _('Container Inspect'));
		o.render = L.bind(() => {
			if (inspectDiv) {
				return inspectDiv;
			}

			inspectDiv = E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
				E('div', { 'style': 'margin-bottom: 10px;' }, [
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'style': 'margin-left: 5px;',
						'click': () => this.refreshInspectData(this_container.Id),
					}, _('Inspect') + ' 🔎'),
				]),
			]);

			return inspectDiv;
		}, this);

		o = s.taboption('inspect', form.DummyValue, 'json');
		o.cfgvalue = () => E('pre', { style: 'overflow-x: auto; white-space: pre-wrap; word-wrap: break-word;',
			id: 'container-inspect-output' }, 
			_('Inspect data not loaded yet. Click Inspect.'));


		// TERMINAL TAB
		s.tab('console', _('Console'));

		o = s.taboption('console', form.DummyValue, 'console_controls', _('Console Connection'));
		o.render = L.bind(() => {
			const status = this.getContainerStatus(this_container);
			const isRunning = status === 'running';

			if (!isRunning) {
				return E('div', { 'class': 'alert-message warning' },
					_('Container is not running. Cannot connect to console.'));
			}

			const consoleDiv = E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
				E('div', { 'style': 'margin-bottom: 15px;' }, [
					E('label', { 'style': 'margin-right: 10px;' }, _('Command:')),
					E('span', { 'id': 'console-command-wrapper' }, [
						new ui.Combobox('/bin/sh', [
							'/bin/ash',
							'/bin/bash',
						], {id: 'console-command' }).render()
					]),
					E('label', { 'style': 'margin-right: 10px; margin-left: 20px;' }, _('User(-u)')),
					E('input', {
						'type': 'text',
						'id': 'console-uid',
						'class': 'cbi-input-text',
						'placeholder': 'e.g., root or user id',
						'style': 'width: 150px; margin-right: 10px;'
					}),
					E('label', { 'style': 'margin-right: 10px; margin-left: 20px;' }, _('Port:')),
					E('input', {
						'type': 'number',
						'id': 'console-port',
						'class': 'cbi-input-text',
						'value': '7682',
						'min': '1024',
						'max': '65535',
						'style': 'width: 100px; margin-right: 10px;'
					}),
					E('button', {
						'class': 'cbi-button cbi-button-positive',
						'id': 'console-connect-btn',
						'click': () => this.connectConsole(this_container.Id)
					}, _('Connect')),
				]),
				E('div', {
					'id': 'console-frame-container',
					'style': 'display: none; margin-top: 15px;'
				}, [
					E('div', { 'style': 'margin-bottom: 10px;' }, [
						E('button', {
							'class': 'cbi-button cbi-button-negative',
							'click': () => this.disconnectConsole()
						}, _('Disconnect')),
						E('span', {
							'id': 'console-status',
							'style': 'margin-left: 10px; font-style: italic;'
						}, _('Connected to container console'))
					]),
					E('iframe', {
						'id': 'ttyd-frame',
						'class': 'xterm',
						'src': '',
						'style': 'width: 100%; height: 600px; border: 1px solid #ccc; border-radius: 3px;'
					})
				])
			]);

			return consoleDiv;
		}, this);

		// WEBSOCKET TAB
		s.tab('wsconsole', _('WebSocket'));

		dm2.js_api_ready.then(([apiAvailable, host]) => {
			// Wait for JS API availability check to complete
			// Check if JS API is available
			if (!apiAvailable) {
				return;
			}

		o = s.taboption('wsconsole', form.DummyValue, 'wsconsole_controls', _('WebSocket Console'));
		o.render = L.bind(function() {
			const status = this.getContainerStatus(this_container);
			const isRunning = status === 'running';

				if (!isRunning) {
					return E('div', { 'class': 'alert-message warning' },
						_('Container is not running. Cannot connect to WebSocket console.'));
				}
				const wsDiv = E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
					E('div', { 'style': 'margin-bottom: 10px;' }, [
						E('label', { 'style': 'margin-right: 10px;' }, _('Streams:')),
						E('label', { 'style': 'margin-right: 6px;' }, [
							E('input', { 'type': 'checkbox', 'id': 'ws-stdin', 'checked': 'checked', 'style': 'margin-right: 4px;' }),
							_('Stdin')
						]),
						E('label', { 'style': 'margin-right: 6px;' }, [
							E('input', { 'type': 'checkbox', 'id': 'ws-stdout', 'checked': 'checked', 'style': 'margin-right: 4px;' }),
							_('Stdout')
						]),
						E('label', { 'style': 'margin-right: 6px;' }, [
							E('input', { 'type': 'checkbox', 'id': 'ws-stderr', 'style': 'margin-right: 4px;' }),
							_('Stderr')
						]),
						E('label', { 'style': 'margin-right: 6px;' }, [
							E('input', { 'type': 'checkbox', 'id': 'ws-logs', 'style': 'margin-right: 4px;' }),
							_('Include logs')
						]),
						E('button', {
							'class': 'cbi-button cbi-button-positive',
							'id': 'ws-connect-btn',
							'click': () => this.connectWebsocketConsole()
						}, _('Connect')),
						E('button', {
							'class': 'cbi-button cbi-button-neutral',
							'click': () => this.disconnectWebsocketConsole(),
							'style': 'margin-left: 6px;'
						}, _('Disconnect')),
						E('span', { 'id': 'ws-console-status', 'style': 'margin-left: 10px; color: #666;' }, _('Disconnected')),
					]),
					E('div', {
						'id': 'ws-console-output',
						'style': 'height: 320px; border: 1px solid #ccc; border-radius: 3px; padding: 8px; background:#111; color:#0f0; font-family: monospace; overflow: auto; white-space: pre-wrap;'
					}, ''),
					E('div', { 'style': 'margin-top: 10px; display: flex; gap: 6px;' }, [
						E('textarea', {
							'id': 'ws-console-input',
							'rows': '3',
							'placeholder': _('Type command here... (Ctrl+D to detach)'),
							'style': 'flex: 1; padding: 6px; font-family: monospace; resize: vertical;',
							'keydown': (ev) => {
								if (ev.key === 'Enter' && !ev.shiftKey) {
									ev.preventDefault();
									this.sendWebsocketInput();
								} else if (ev.key === 'd' && ev.ctrlKey) {
									ev.preventDefault();
									this.sendWebsocketDetach();
								}
							}
						}),
						E('button', {
							'class': 'cbi-button cbi-button-positive',
							'click': () => this.sendWebsocketInput()
						}, _('Send'))
					])
				]);

				return wsDiv;
			}, this);
		});

		// LOGS TAB
		s.tab('logs', _('Logs'));
		let logsDiv = null;
		let logsLoaded = false;

		o = s.taboption('logs', form.DummyValue, 'log_controls', _('Log Controls'));
		o.render = L.bind(() => {
			if (logsDiv) {
				return logsDiv;
			}

			logsDiv = E('div', { 'class': 'cbi-section', 'style': tabSectionPad }, [
				E('div', { 'style': 'margin-bottom: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;' }, [
					E('label', { 'style': 'margin-right: 6px;' }, _('Lines to show:')),
					E('input', {
						'type': 'number',
						'id': 'log-lines',
						'class': 'cbi-input-text',
						'value': '100',
						'min': '1',
						'style': 'width: 80px;'
					}),
					E('button', {
						'class': 'cbi-button cbi-button-positive',
						'click': () => this.loadLogs(this_container.Id)
					}, _('Load Logs')),
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'click': () => this.clearLogs()
					}, _('Clear')),
					E('label', { 'style': 'margin-left: 10px; display: inline-flex; align-items: center; gap: 4px;' }, [
						E('input', {
							'type': 'checkbox',
							'id': 'log-auto-refresh',
							'checked': this.logsAutoRefreshEnabled ? 'checked' : null,
							'change': (ev) => this.toggleLogsAutoRefresh(this_container.Id, ev.target.checked),
						}),
						_('Auto refresh')
					]),
					E('label', { 'style': 'margin-left: 4px;' }, _('Every (s):')),
					E('input', {
						'type': 'number',
						'id': 'log-refresh-interval',
						'class': 'cbi-input-text',
						'value': String(this.logsRefreshIntervalSeconds),
						'min': '2',
						'max': '300',
						'style': 'width: 70px;',
						'change': (ev) => this.updateLogsRefreshInterval(this_container.Id, ev.target.value),
					}),
					E('label', { 'style': 'margin-left: 10px;' }, _('Font size:')),
					E('input', {
						'type': 'range',
						'id': 'log-font-size',
						'min': '10',
						'max': '24',
						'step': '1',
						'value': String(this.logsFontSizePx),
						'style': 'width: 110px;',
						'input': (ev) => this.setLogsFontSize(ev.target.value),
					}),
					E('span', { 'id': 'log-font-size-value', 'style': 'min-width: 36px;' }, `${this.logsFontSizePx}px`)
				]),
				E('div', {
					'id': 'container-logs-text',
					'style': `width: 100%; font-family: monospace; font-size: ${this.logsFontSizePx}px; line-height: 1.4; padding: 10px; border: 1px solid #ccc; overflow: auto;`,
					'innerHTML': ''
				})
			]);

			return logsDiv;
		}, this);

		o = s.taboption('logs', form.DummyValue, 'log_display', _('Container Logs'));
		o.render = L.bind(() => {
			// Auto-load logs when tab is first accessed
			if (!logsLoaded) {
				logsLoaded = true;
				this.loadLogs(this_container.Id);
				if (this.logsAutoRefreshEnabled)
					this.startLogsAutoRefresh(this_container.Id);
				if (!this.logsUnloadHooked) {
					this.logsUnloadHooked = true;
					window.addEventListener('beforeunload', () => this.stopLogsAutoRefresh());
				}
			}
			return E('div');
		}, this);

		this.map = m;

		// Render the form and add buttons above it
		return m.render()
			.then(fe => {
				mainContainer.appendChild(fe);

				// Auto-refresh Stats table every 5 seconds (if container is running)
				poll.add(L.bind(() => {
					if (this.getContainerStatus(this_container) !== 'running')
						return Promise.resolve();
					if (!this.statsLoadedOnce)
						return Promise.resolve();

					return this.refreshStatsData(this_container.Id);
				}, this), 5);

				// Auto-refresh PS table every 5 seconds (if container is running)
				poll.add(L.bind(() => {
					if (this.getContainerStatus(this_container) !== 'running')
						return Promise.resolve();
					if (!this.psLoadedOnce || !this.psTable)
						return Promise.resolve();

					return this.refreshProcessTable(this_container.Id);
				}, this), 5);

				return mainContainer;
			});
	},

	handleSave(ev) {
		ev?.preventDefault();

		const map = this.map;
		if (!map)
			return Promise.reject(new Error(_('Form is not ready yet.')));
		const originalName = String(this.container?.Name || '').replace(/^\//, '');

		const get = (opt) => map.data.get('json', 'cont', opt);
		const gethc = (opt) => map.data.get('json', 'hostcfg', opt);
		const toBool = (val) => (val === 1 || val === '1' || val === true);
		const toInt = (val) => val ? Number.parseInt(val) : undefined;

		return map.parse()
			.then(() => {
				const this_container = map.data.get('json', 'cont') || {};
				const id = this_container?.Id;
				if (!id)
					throw new Error(_('Missing container ID'));

				const updateBody = {
					CpuShares: toInt(gethc('CpuShares')),
					Memory: toInt(gethc('Memory')),
					MemorySwap: toInt(gethc('MemorySwap')),
					MemoryReservation: toInt(gethc('MemoryReservation')),
					BlkioWeight: toInt(gethc('BlkioWeight')),
					CpuPeriod: toInt(gethc('CpuPeriod')),
					CpuQuota: toInt(gethc('CpuQuota')),
					NanoCPUs: toInt(Number(gethc('NanoCpus') || 0) * (10 ** 9)),
					OomKillDisable: toBool(gethc('OomKillDisable')),
					RestartPolicy: { Name: get('restart_policy') || this_container.HostConfig?.RestartPolicy?.Name || 'no' },
				};

				for (const key of Object.keys(updateBody)) {
					if (updateBody[key] === undefined || updateBody[key] === null)
						delete updateBody[key];
				}

				return dm2.container_update({ id: id, body: updateBody })
					.then((response) => ({ id, this_container, response }));
			})
			.then(({ id, this_container, response }) => {
				if (response?.code >= 300)
					throw new Error(response?.body?.message || _('Unknown error'));

				if (response?.body?.Warnings)
					ui.addTimeLimitedNotification(_('Container updated with warnings'), [response?.body?.Warnings], 6000, 'warning');
				else
					ui.addTimeLimitedNotification(_('Container updated'), [_('OK')], 4000, 'info');

				const currentName = originalName || String(this_container?.Name || '').replace(/^\//, '');
				const nameInput = document.querySelector('input[name="cbid.json.cont.Name"]');
				const parsedCont = map.data?.data?.cont || {};
				const targetName = String(
					nameInput?.value ?? parsedCont?.Name ?? get('Name') ?? ''
				).trim().replace(/^\//, '');
				if (!targetName || targetName === currentName)
					return true;

				return dm2.container_rename({ id: id, query: { name: targetName } })
					.then((renameResponse) => {
						if (renameResponse?.code >= 300)
							throw new Error(renameResponse?.body?.message || _('Container rename failed'));
						ui.addTimeLimitedNotification(_('Container renamed'), [_('OK')], 4000, 'info');
						return true;
					});
			})
			.then(() => {
				setTimeout(() => location.reload(), 1000);
				return true;
			})
			.catch((err) => {
				ui.addTimeLimitedNotification(_('Container update failed'), [err?.message || String(err)], 7000, 'warning');
				return false;
			});
	},

	pruneUndefined(obj) {
		if (Array.isArray(obj))
			return obj.map((v) => this.pruneUndefined(v));
		if (!obj || typeof obj !== 'object')
			return obj;
		const out = {};
		for (const [k, v] of Object.entries(obj)) {
			if (v === undefined || v === null)
				continue;
			out[k] = this.pruneUndefined(v);
		}
		return out;
	},

	isSha256ImageId(value) {
		if (!value)
			return false;
		return /^sha256:[0-9a-f]{12,}$/i.test(String(value).trim());
	},

	normalizeImageReference(imageRef) {
		if (!imageRef)
			return '';
		const ref = String(imageRef).trim();
		if (!ref || ref.includes('@sha256:') || this.isSha256ImageId(ref))
			return ref;
		const lastSlash = ref.lastIndexOf('/');
		const lastColon = ref.lastIndexOf(':');
		return (lastColon > lastSlash) ? ref : `${ref}:latest`;
	},

	splitImageReference(imageRef) {
		if (!imageRef)
			return { fromImage: '', tag: '' };
		if (this.isSha256ImageId(imageRef))
			return { fromImage: '', tag: '' };
		if (imageRef.includes('@sha256:'))
			return { fromImage: imageRef, tag: '' };
		const lastSlash = imageRef.lastIndexOf('/');
		const lastColon = imageRef.lastIndexOf(':');
		if (lastColon > lastSlash)
			return { fromImage: imageRef.substring(0, lastColon), tag: imageRef.substring(lastColon + 1) };
		return { fromImage: imageRef, tag: 'latest' };
	},

	findImageIdByReference(images, imageRef) {
		const target = this.normalizeImageReference(imageRef);
		if (!Array.isArray(images) || !target)
			return null;
		const img = images.find((i) => Array.isArray(i?.RepoTags) && i.RepoTags.includes(target));
		return img?.Id || null;
	},

	stripSha256Prefix(value) {
		return String(value || '').replace(/^sha256:/, '').trim();
	},

	getPullableRefFromImageEntry(image) {
		const tags = Array.isArray(image?.RepoTags)
			? image.RepoTags.filter((t) => t && t !== '<none>:<none>')
			: [];
		if (tags.length > 0)
			return this.normalizeImageReference(tags[0]);

		const digests = Array.isArray(image?.RepoDigests)
			? image.RepoDigests.filter((d) => typeof d === 'string' && d.includes('@sha256:'))
			: [];
		if (digests.length > 0) {
			const repo = digests[0].split('@')[0];
			return this.normalizeImageReference(repo);
		}

		return '';
	},

	resolveUpgradeImageReference(configImageRef, containerImageId, imageList) {
		const directRef = this.normalizeImageReference(configImageRef);
		const directParts = this.splitImageReference(directRef);
		if (directParts.fromImage)
			return directRef;

		const wantedIds = new Set(
			[containerImageId, configImageRef]
				.map((v) => this.stripSha256Prefix(v))
				.filter((v) => v)
		);

		for (const image of (Array.isArray(imageList) ? imageList : [])) {
			const imgId = this.stripSha256Prefix(image?.Id);
			if (!imgId || !wantedIds.has(imgId))
				continue;
			const ref = this.getPullableRefFromImageEntry(image);
			if (ref)
				return ref;
		}

		if (typeof configImageRef === 'string' && configImageRef.includes('@sha256:')) {
			const repo = configImageRef.split('@')[0];
			if (repo)
				return this.normalizeImageReference(repo);
		}

		return '';
	},

	buildEndpointConfig(endpoint) {
		const ipam = {};
		const ipv4 = endpoint?.IPAMConfig?.IPv4Address || endpoint?.IPAddress;
		const ipv6 = endpoint?.IPAMConfig?.IPv6Address || endpoint?.GlobalIPv6Address;
		if (ipv4)
			ipam.IPv4Address = ipv4;
		if (ipv6)
			ipam.IPv6Address = ipv6;

		return this.pruneUndefined({
			Aliases: endpoint?.Aliases,
			Links: endpoint?.Links,
			DriverOpts: endpoint?.DriverOpts,
			IPAMConfig: Object.keys(ipam).length ? ipam : undefined,
			MacAddress: endpoint?.MacAddress,
		});
	},

	buildUpgradeCreatePayload(container, imageRefOverride) {
		const config = container?.Config || {};
		const hostConfig = { ...(container?.HostConfig || {}) };
		const connectedNetworks = Object.entries(container?.NetworkSettings?.Networks || {});

		let primaryNetworkName = hostConfig.NetworkMode;
		if (!primaryNetworkName && connectedNetworks.length > 0)
			primaryNetworkName = connectedNetworks[0][0];

		let primaryEndpoint = null;
		const extraNetworks = {};
		for (const [networkName, endpoint] of connectedNetworks) {
			if (!primaryEndpoint && networkName === primaryNetworkName) {
				primaryEndpoint = endpoint;
				continue;
			}
			if (!primaryEndpoint) {
				primaryEndpoint = endpoint;
				primaryNetworkName = networkName;
				continue;
			}
			extraNetworks[networkName] = endpoint;
		}

		const createBody = this.pruneUndefined({
			Hostname: config.Hostname,
			Domainname: config.Domainname,
			User: config.User,
			AttachStdin: config.AttachStdin,
			AttachStdout: config.AttachStdout,
			AttachStderr: config.AttachStderr,
			Tty: config.Tty,
			OpenStdin: config.OpenStdin,
			StdinOnce: config.StdinOnce,
			Env: config.Env,
			Cmd: config.Cmd,
			// Force the recreated container to use the resolved target image from upgrade flow.
			Image: imageRefOverride || config.Image,
			Volumes: config.Volumes,
			WorkingDir: config.WorkingDir,
			Entrypoint: config.Entrypoint,
			OnBuild: config.OnBuild,
			Labels: config.Labels,
			ExposedPorts: config.ExposedPorts,
			StopSignal: config.StopSignal,
			StopTimeout: config.StopTimeout,
			Shell: config.Shell,
			HostConfig: hostConfig,
			NetworkingConfig: primaryNetworkName ? {
				EndpointsConfig: {
					[primaryNetworkName]: this.buildEndpointConfig(primaryEndpoint),
				}
			} : undefined,
		});

		return { createBody, extraNetworks };
	},

	upgradeContainer(ev, this_container) {
		ev?.preventDefault();

		if (!this_container?.Id) {
			this.showNotification(_('Upgrade failed'), _('Container ID is missing'), 7000, 'error');
			return;
		}

		if (!confirm(_('Upgrade this container? This will pull the latest image and recreate the container.')))
			return;

		const originalName = (this_container.Name || '').replace(/^\//, '');
		const originalStatus = this.getContainerStatus(this_container);
		const oldContainerId = this_container.Id;
		const oldImageId = (this_container.Image || '').replace(/^sha256:/, '');
		const configImageRef = String(this_container.Config?.Image || '').trim();
		let imageRef = this.normalizeImageReference(configImageRef);
		let imageParts = this.splitImageReference(imageRef);

		let renamedOldName = `${originalName}_old_${Math.floor(Date.now() / 1000)}`;
		let newContainerId = null;
		let extraNetworks = {};

		this.showNotification(_('Upgrade'), _('Resolving image reference...'), 3000, 'info');

		return Promise.resolve()
			.then(() => {
				if (imageParts.fromImage)
					return true;

				return dm2.image_list({ query: { all: true } }).then((imagesResponse) => {
					const imageList = Array.isArray(imagesResponse?.body) ? imagesResponse.body : [];
					const resolvedRef = this.resolveUpgradeImageReference(configImageRef, this_container.Image, imageList);
					if (!resolvedRef) {
						if (this.isSha256ImageId(configImageRef) || this.isSha256ImageId(this_container.Image)) {
							throw new Error(_('Container image is local ID only. No pullable repository tag was found.'));
						}
						throw new Error(_('Container image is missing'));
					}
					imageRef = resolvedRef;
					imageParts = this.splitImageReference(imageRef);
					if (!imageParts.fromImage)
						throw new Error(_('Could not resolve a pullable image reference'));
					this.showNotification(_('Upgrade'), _('Using image: ') + imageRef, 5000, 'notice');
					return true;
				});
			})
			.then(() => this.handleXHRTransfer({
				q_params: { query: { fromImage: imageParts.fromImage, tag: imageParts.tag } },
				commandCPath: '/images/create',
				commandDPath: '/images/create',
				commandTitle: _('Upgrade'),
				commandMessage: _('Pulling latest image...'),
				successMessage: _('Image pull completed'),
				noFileUpload: true,
			}))
			.then(() => {
				return dm2.image_list({ query: { all: true } });
			})
			.then((imagesResponse) => {
				const imageList = Array.isArray(imagesResponse?.body) ? imagesResponse.body : [];
				const newImageId = (this.findImageIdByReference(imageList, imageRef) || '').replace(/^sha256:/, '');

				if (oldImageId && newImageId && oldImageId === newImageId) {
					this.showNotification(_('Upgrade'), _('Container image is already up to date'), 6000, 'notice');
					return false;
				}

				if (originalStatus === 'running' || originalStatus === 'paused') {
					return dm2.container_stop({ id: oldContainerId, query: {} }).then((res) => {
						if (res?.code >= 300)
							throw new Error(res?.body?.message || _('Failed to stop container'));
						return true;
					});
				}

				return true;
			})
			.then((continueFlow) => {
				if (!continueFlow)
					return false;

				return dm2.container_rename({ id: oldContainerId, query: { name: renamedOldName } }).then((res) => {
					if (res?.code >= 300)
						throw new Error(res?.body?.message || _('Failed to rename old container'));
					return true;
				});
			})
			.then((continueFlow) => {
				if (!continueFlow)
					return false;

				const payload = this.buildUpgradeCreatePayload(this_container, imageRef);
				extraNetworks = payload.extraNetworks || {};
				return dm2.container_create({ query: { name: originalName }, body: payload.createBody });
			})
			.then((createResponse) => {
				if (!createResponse || createResponse === false)
					return false;
				if (createResponse?.code >= 300)
					throw new Error(createResponse?.body?.message || _('Failed to create upgraded container'));

				newContainerId = createResponse?.body?.Id || originalName;
				const connectOps = [];
				for (const [networkName, endpoint] of Object.entries(extraNetworks)) {
					connectOps.push(
						dm2.network_connect({
							id: networkName,
							body: {
								Container: newContainerId,
								EndpointConfig: this.buildEndpointConfig(endpoint),
							}
						}).then((res) => {
							if (res?.code >= 300)
								throw new Error(_('Failed to connect network: ') + networkName);
							return true;
						})
					);
				}

				return Promise.all(connectOps).then(() => true);
			})
			.then((continueFlow) => {
				if (!continueFlow)
					return false;
				if (originalStatus !== 'running')
					return true;
				return dm2.container_start({ id: newContainerId, query: {} }).then((res) => {
					if (res?.code >= 300)
						throw new Error(res?.body?.message || _('Failed to start upgraded container'));
					return true;
				});
			})
			.then((ok) => {
				if (!ok)
					return false;
				this.showNotification(
					_('Upgrade completed'),
					_('New container created, old container renamed to ') + renamedOldName,
					8000,
					'success'
				);
				setTimeout(() => location.reload(), 1500);
				return true;
			})
			.catch((err) => {
				this.showNotification(_('Upgrade failed'), err?.message || String(err), 8000, 'error');
				return false;
			});
	},

	connectWebsocketConsole() {
		const connectBtn = document.getElementById('ws-connect-btn');
		const statusEl = document.getElementById('ws-console-status');
		const outputEl = document.getElementById('ws-console-output');
		const view = this;

		if (connectBtn) connectBtn.disabled = true;
		if (statusEl) statusEl.textContent = _('Connecting…');

		// Clear the output buffer when connecting anew
		if (outputEl) outputEl.innerHTML = '';

		// Initialize input buffer
		this.consoleInputBuffer = '';

		// Tear down any previous hijack or websocket without user-facing noise
		if (this.hijackController) {
			try { this.hijackController.abort(); } catch (e) {}
			this.hijackController = null;
		}
		if (this.consoleWs) {
			try {
				this.consoleWs.onclose = null;
				this.consoleWs.onerror = null;
				this.consoleWs.onmessage = null;
				this.consoleWs.close();
			} catch (e) {}
			this.consoleWs = null;
		}

		const stdin = document.getElementById('ws-stdin')?.checked ? '1' : '0';
		const stdout = document.getElementById('ws-stdout')?.checked ? '1' : '0';
		const stderr = document.getElementById('ws-stderr')?.checked ? '1' : '0';
		const logs = document.getElementById('ws-logs')?.checked ? '1' : '0';
		const stream = '1';

		const params = {
			stdin: stdin,
			stdout: stdout,
			stderr: stderr,
			logs: logs,
			stream: stream,
			detachKeys: 'ctrl-d',
		}

		dm2.container_attach_ws({ id: this.container.Id, query: params })
		.then(response => {
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			// Get the WebSocket connection
			const ws = response.ws || response.body;
			let opened = false;

			if (!ws || ws.readyState === undefined) {
				throw new Error('No WebSocket connection');
			}

			// Expect binary frames from Docker hijack; decode as UTF-8 text
			ws.binaryType = 'arraybuffer';

			// Set up WebSocket message handler
			ws.onmessage = (event) => {
				try {
					const renderAndAppend = (t) => {
						if (outputEl && t) {
							outputEl.innerHTML += dm2.ansiToHtml(t);
							outputEl.scrollTop = outputEl.scrollHeight;
						}
					};

					let text = '';
					const data = event.data;

					if (typeof data === 'string') {
						text = data;
					} else if (data instanceof ArrayBuffer) {
						text = new TextDecoder('utf-8').decode(new Uint8Array(data));
					} else if (data instanceof Blob) {
						// Fallback for Blob frames
						const reader = new FileReader();
						reader.onload = () => {
							const buf = reader.result;
							const t = new TextDecoder('utf-8').decode(new Uint8Array(buf));
							renderAndAppend(t);
						};
						reader.readAsArrayBuffer(data);
						return;
					}

					renderAndAppend(text);
				} catch (e) {
					console.error('Error processing message:', e);
				}
			};

			// Set up WebSocket error handler
			ws.onerror = (error) => {
				console.error('WebSocket error:', error);
				if (statusEl) statusEl.textContent = _('Error');
				view.showNotification(_('Error'), _('WebSocket error'), 7000, 'error');
				if (ws === view.consoleWs) {
					view.consoleWs = null;
				}
			};

			// Set up WebSocket close handler
			ws.onclose = (evt) => {
				if (!opened) return; // Suppress close noise from previous/failed sockets
				if (statusEl) statusEl.textContent = _('Disconnected');
				if (connectBtn) connectBtn.disabled = false;
				if (ws === view.consoleWs) {
					view.consoleWs = null;
				}
				const code = evt?.code;
				const reason = evt?.reason;
				view.showNotification(_('Info'), _('Console connection closed') + (code ? ` (code: ${code}${reason ? ', ' + reason : ''})` : ''), 3000, 'info');
			};

			ws.onopen = () => {
				opened = true;
				if (statusEl) statusEl.textContent = _('Connected');
				if (connectBtn) connectBtn.disabled = false;
				view.showNotification(_('Success'), _('Console connected'), 3000, 'info');

				// Store WebSocket reference so it doesn't get garbage collected
				view.consoleWs = ws;
			};

			// If already open (promise resolved after onopen), set state immediately
			if (ws.readyState === WebSocket.OPEN) {
				opened = true;
				view.consoleWs = ws;
				if (statusEl) statusEl.textContent = _('Connected');
				if (connectBtn) connectBtn.disabled = false;
			}
		})
		.catch(err => {
			if (err.name === 'AbortError') {
				if (statusEl) statusEl.textContent = _('Disconnected');
			} else {
				if (statusEl) statusEl.textContent = _('Error');
				view.showNotification(_('Error'), err?.message || String(err), 7000, 'error');
			}
			if (connectBtn) connectBtn.disabled = false;
			view.hijackController = null;
		});
	},

	disconnectWebsocketConsole() {
		const statusEl = document.getElementById('ws-console-status');
		const connectBtn = document.getElementById('ws-connect-btn');

		if (this.hijackController) {
			this.hijackController.abort();
			this.hijackController = null;
		}

		if (statusEl) statusEl.textContent = _('Disconnected');
		if (connectBtn) connectBtn.disabled = false;
		this.showNotification(_('Info'), _('Console disconnected'), 3000, 'info');
	},

	sendWebsocketInput() {
		const inputEl = document.getElementById('ws-console-input');
		if (!inputEl) return;

		const text = inputEl.value || '';

		// Check if WebSocket is actually connected
		if (this.consoleWs && this.consoleWs.readyState === WebSocket.OPEN) {
			try {
				const payload = text.endsWith('\n') ? text : `${text}\n`;
				this.consoleWs.send(payload);
				inputEl.value = '';
			} catch (e) {
				console.error('Error sending:', e);
				this.showNotification(_('Error'), _('Failed to send data'), 5000, 'error');
			}
		} else {
			this.showNotification(_('Error'), _('Console is not connected'), 5000, 'error');
		}
	},

	sendWebsocketDetach() {
		// Send ctrl-d (ASCII 4, EOT) to detach
		if (this.consoleWs && this.consoleWs.readyState === WebSocket.OPEN) {
			try {
				this.consoleWs.send('\x04');
				this.showNotification(_('Info'), _('Detach signal sent (Ctrl+D)'), 3000, 'info');
			} catch (e) {
				console.error('Error sending detach:', e);
				this.showNotification(_('Error'), _('Failed to send detach signal'), 5000, 'error');
			}
		} else {
			this.showNotification(_('Error'), _('Console is not connected'), 5000, 'error');
		}
	},

	handleFileUpload(container_id) {
		const path = document.getElementById('file-path')?.value || '/';

		const q_params = { path: encodeURIComponent(path) };

		return this.super('handleXHRTransfer', [{
			q_params: { query: q_params },
			method: 'PUT',
			commandCPath: `/container/archive/put/${container_id}/`,
			commandDPath: `/containers/${container_id}/archive`,
			commandTitle: _('Uploading…'),
			commandMessage: _('Uploading file to container…'),
			successMessage: _('File uploaded to') + ': ' + path,
			pathElementId: 'file-path',
			defaultPath: '/'
		}]);
	},

	handleFileDownload(container_id) {
		const path = document.getElementById('file-path')?.value || '/';
		const view = this;

		if (!path || path === '') {
			this.showNotification(_('Error'), _('Please specify a path'), 5000, 'error');
			return;
		}

		// Direct HTTP download bypassing RPC buffering
		window.location.href = `${this.dockerman_url}/container/archive/get/${container_id}` + `/?path=${encodeURIComponent(path)}`;
		return;
	},

	handleInfoArchive(container_id) {
		const path = document.getElementById('file-path')?.value || '/';
		const fileTextarea = document.getElementById('container-file-text');

		if (!fileTextarea) return;

		return dm2.container_info_archive({ id: container_id, query: { path: path } })
			.then((response) => {
				if (response?.code >= 300) {
					fileTextarea.value = _('Path error') + '\n' + (response?.body?.message || _('Unknown error'));
					this.showNotification(_('Error'), [response?.body?.message || _('Path error')], 7000, 'error');
					return false;
				}

				// check response?.headers?.entries?.length in case fetch API is used 
				if (!response.headers || response?.headers?.entries?.length == 0) return true;

				let fileInfo;
				try {
					fileInfo = JSON.parse(atob(response?.headers?.get?.('x-docker-container-path-stat') || response?.headers?.['x-docker-container-path-stat']));
					fileTextarea.value = 
						`name: ${fileInfo?.name}\n` +
						`size: ${fileInfo?.size}\n` +
						`mode: ${this.modeToRwx(fileInfo?.mode)}\n` +
						`mtime: ${fileInfo?.mtime}\n` +
						`linkTarget: ${fileInfo?.linkTarget}\n`;
				} catch {
					this.showNotification(_('Missing header or CORS interfering'), ['X-Docker-Container-Path-Stat'], 5000, 'notice');
				}

				return true;
			})
			.catch((err) => {
				const errorMsg = err?.message || String(err) || _('Path error');
				fileTextarea.value = _('Path error') + '\n' + errorMsg;
				this.showNotification(_('Error'), [errorMsg], 7000, 'error');
				return false;
			});
	},

	refreshStatsData(container_id) {
		container_id = container_id || this.containerId;
		if (!container_id || this.statsLoadPending)
			return Promise.resolve(false);

		this.statsLoadedOnce = true;
		this.statsLoadPending = true;

		return dm2.container_stats({ id: container_id, query: { 'stream': false, 'one-shot': true } })
			.then((res) => {
				if (res?.code >= 300 || !res?.body)
					throw new Error(res?.body?.message || _('Failed to load stats'));

				this.updateStatsView(res.body);
				return true;
			})
			.catch((err) => {
				console.error('Failed to load container stats', err);
				return false;
			})
			.finally(() => {
				this.statsLoadPending = false;
			});
	},

	refreshInspectData(container_id) {
		container_id = container_id || this.containerId;
		if (!container_id || this.inspectLoadPending)
			return Promise.resolve(false);

		this.inspectLoadedOnce = true;
		this.inspectLoadPending = true;

		return dm2.container_inspect({ id: container_id })
			.then((response) => {
				if (response?.code >= 300)
					throw new Error(response?.body?.message || _('Failed to load inspect data'));

				const output = document.getElementById('container-inspect-output');
				if (output)
					output.textContent = JSON.stringify(response?.body || {}, null, 2);
				return true;
			})
			.catch((err) => {
				const output = document.getElementById('container-inspect-output');
				if (output)
					output.textContent = _('Inspect error: ') + (err?.message || String(err));
				return false;
			})
			.finally(() => {
				this.inspectLoadPending = false;
			});
	},

	refreshProcessTable(container_id) {
		container_id = container_id || this.containerId;
		if (!container_id || this.psLoadPending)
			return Promise.resolve(false);

		this.psLoadedOnce = true;
		this.psLoadPending = true;

		return dm2.container_top({ id: container_id, query: { 'ps_args': this.psArgs || '-ww' } })
			.then((res) => {
				if (res?.code >= 300 || !res?.body)
					throw new Error(res?.body?.message || _('Failed to load process list'));

				const body = res.body;
				if (body.Titles && JSON.stringify(body.Titles) !== JSON.stringify(this.psTitles)) {
					this.psTitles = body.Titles;
					const psTableEl = document.getElementById('ps-table');
					if (psTableEl && psTableEl.parentNode) {
						const newTable = new L.ui.Table(
							body.Titles.map(t => _(t)),
							{ id: 'ps-table' },
							E('em', [_('No processes running')])
						);
						newTable.update(body.Processes || []);
						this.psTable = newTable;
						psTableEl.parentNode.replaceChild(newTable.render(), psTableEl);
					}
				} else if (this.psTable) {
					this.psTable.update(body.Processes || []);
				}

				const psField = document.getElementById('raw-ps-field');
				if (psField)
					psField.textContent = JSON.stringify(body, null, 2);

				return true;
			})
			.catch((err) => {
				console.error('Failed to load container processes', err);
				return false;
			})
			.finally(() => {
				this.psLoadPending = false;
			});
	},

	setLogsFontSize(size) {
		const parsed = Number(size);
		if (Number.isNaN(parsed))
			return;

		const clamped = Math.min(24, Math.max(10, parsed));
		this.logsFontSizePx = clamped;

		const logsDiv = document.getElementById('container-logs-text');
		if (logsDiv)
			logsDiv.style.fontSize = `${clamped}px`;

		const label = document.getElementById('log-font-size-value');
		if (label)
			label.textContent = `${clamped}px`;
	},

	updateLogsRefreshInterval(container_id, seconds) {
		const parsed = Number(seconds);
		const clamped = (!Number.isNaN(parsed) && parsed >= 2) ? Math.min(parsed, 300) : 5;
		this.logsRefreshIntervalSeconds = clamped;

		const input = document.getElementById('log-refresh-interval');
		if (input)
			input.value = String(clamped);

		if (this.logsAutoRefreshEnabled) {
			this.stopLogsAutoRefresh();
			this.startLogsAutoRefresh(container_id || this.containerId);
		}
	},

	toggleLogsAutoRefresh(container_id, enabled) {
		this.logsAutoRefreshEnabled = (enabled === true);
		if (this.logsAutoRefreshEnabled)
			this.startLogsAutoRefresh(container_id || this.containerId);
		else
			this.stopLogsAutoRefresh();
	},

	startLogsAutoRefresh(container_id) {
		container_id = container_id || this.containerId;
		if (!container_id)
			return;

		this.stopLogsAutoRefresh();

		const intervalMs = Math.max(2, Number(this.logsRefreshIntervalSeconds || 5)) * 1000;
		this.logsAutoRefreshTimer = setInterval(() => {
			this.loadLogs(container_id);
		}, intervalMs);
	},

	stopLogsAutoRefresh() {
		if (this.logsAutoRefreshTimer) {
			clearInterval(this.logsAutoRefreshTimer);
			this.logsAutoRefreshTimer = null;
		}
	},

	loadLogs(container_id) {
		container_id = container_id || this.containerId;
		if (this.logsLoadPending)
			return Promise.resolve(false);

		const parsedLines = parseInt(document.getElementById('log-lines')?.value || '100');
		const lines = (!Number.isNaN(parsedLines) && parsedLines > 0) ? parsedLines : 100;
		const logsDiv = document.getElementById('container-logs-text');

		if (!container_id) {
			this.showNotification(_('Error'), _('Container ID is missing'), 7000, 'error');
			return;
		}

		if (!logsDiv) return;
		this.logsLoadPending = true;

		logsDiv.innerHTML = '<em style="color: #999;">' + _('Loading logs…') + '</em>';

		return dm2.container_logs({ id: container_id, query: { tail: lines, stdout: 1, stderr: 1, follow: 0, timestamps: 0 } })
			.then((response) => {
				if (response?.code >= 300) {
					logsDiv.innerHTML = '<span style="color: #ff5555;">' + _('Error loading logs:') + '</span><br/>' + 
						(response?.body?.message || _('Unknown error'));
					this.showNotification(_('Error'), response?.body?.message || _('Failed to load logs'), 7000, 'error');
					return false;
				}

				const logText = this.decodeLogBody(response?.body) || _('No logs available');
				// Convert ANSI codes to HTML and set innerHTML
				logsDiv.innerHTML = dm2.ansiToHtml(logText);
				logsDiv.scrollTop = logsDiv.scrollHeight;
				return true;
			})
			.catch((err) => {
				const errorMsg = err?.message || String(err) || _('Failed to load logs');
				logsDiv.innerHTML = '<span style="color: #ff5555;">' + _('Error loading logs:') + '</span><br/>' + errorMsg;
				this.showNotification(_('Error'), errorMsg, 7000, 'error');
				return false;
			})
			.finally(() => {
				this.logsLoadPending = false;
			});
	},

	decodeLogBody(body) {
		if (body == null)
			return '';

		if (Array.isArray(body))
			return body.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n');

		if (typeof body !== 'string') {
			if (typeof body === 'object' && body.message)
				return String(body.message);
			return String(body);
		}

		const text = body;
		if (text.length < 8)
			return text;

		// Docker multiplexed logs use an 8-byte frame header. Strip it if present.
		let idx = 0;
		let out = '';
		let parsedFrames = 0;

		while (idx + 8 <= text.length) {
			const streamType = text.charCodeAt(idx) & 0xff;
			const pad1 = text.charCodeAt(idx + 1) & 0xff;
			const pad2 = text.charCodeAt(idx + 2) & 0xff;
			const pad3 = text.charCodeAt(idx + 3) & 0xff;
			const size =
				((text.charCodeAt(idx + 4) & 0xff) << 24) |
				((text.charCodeAt(idx + 5) & 0xff) << 16) |
				((text.charCodeAt(idx + 6) & 0xff) << 8) |
				(text.charCodeAt(idx + 7) & 0xff);
			const next = idx + 8 + size;

			if (streamType < 1 || streamType > 3 || pad1 !== 0 || pad2 !== 0 || pad3 !== 0 || size < 0 || next > text.length)
				break;

			out += text.substring(idx + 8, next);
			idx = next;
			parsedFrames++;
		}

		if (parsedFrames > 0)
			return (out + text.substring(idx)).replace(/\u0000/g, '');

		return text.replace(/\u0000/g, '');
	},

	clearLogs() {
		const logsDiv = document.getElementById('container-logs-text');
		if (logsDiv) {
			logsDiv.innerHTML = '';
		}
	},

	connectConsole(container_id) {
		const commandWrapper = document.getElementById('console-command');
		const selectedItem = commandWrapper?.querySelector('li[selected]');
		const command = selectedItem?.textContent?.trim() || '/bin/sh';
		const uid = document.getElementById('console-uid')?.value || '';
		const port = parseInt(document.getElementById('console-port')?.value || '7682');
		const view = this;

		const connectBtn = document.getElementById('console-connect-btn');
		if (connectBtn) connectBtn.disabled = true;

		// Call RPC to start ttyd
		return dm2.container_ttyd_start({
			id: container_id,
			cmd: command,
			port: port,
			uid: uid
		})
		.then((response) => {
			if (connectBtn) connectBtn.disabled = false;

			if (response?.code >= 300) {
				const errorMsg = response?.body?.error || response?.body?.message || _('Failed to start console');
				view.showNotification(_('Error'), errorMsg, 7000, 'error');
				return false;
			}

			// Show iframe and set source
			const frameContainer = document.getElementById('console-frame-container');
			if (frameContainer) {
				frameContainer.style.display = 'block';
				const ttydFrame = document.getElementById('ttyd-frame');
				if (ttydFrame) {
					// Wait for ttyd to fully start and be ready for connections
					// Use a retry pattern to handle timing variations
					const waitForTtydReady = (attempt = 0, maxAttempts = 5, initialDelay = 500) => {
						const delay = initialDelay + (attempt * 200); // Increase delay on retries

						setTimeout(() => {
							const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
							const ttydUrl = `${protocol}://${window.location.hostname}:${port}`;

							// Test connection with a simple HEAD request
							fetch(ttydUrl, { method: 'HEAD', mode: 'no-cors' })
								.then(() => {
									// Connection successful, load the iframe
									ttydFrame.src = ttydUrl;
								})
								.catch(() => {
									// Connection failed, retry if we haven't exceeded max attempts
									if (attempt < maxAttempts - 1) {
										waitForTtydReady(attempt + 1, maxAttempts, initialDelay);
									} else {
										// Max retries exceeded, load iframe anyway
										ttydFrame.src = ttydUrl;
										view.showNotification(_('Warning'), _('TTYd may still be starting up'), 5000, 'warning');
									}
								});
						}, delay);
					};

					waitForTtydReady();
				}
			}

			view.showNotification(_('Success'), _('Console connected'), 3000, 'info');
			return true;
		})
		.catch((err) => {
			if (connectBtn) connectBtn.disabled = false;
			const errorMsg = err?.message || String(err) || _('Failed to connect to console');
			view.showNotification(_('Error'), errorMsg, 7000, 'error');
			return false;
		});
	},

	disconnectConsole() {
		const frameContainer = document.getElementById('console-frame-container');
		if (frameContainer) {
			frameContainer.style.display = 'none';
			const ttydFrame = document.getElementById('ttyd-frame');
			if (ttydFrame) {
				ttydFrame.src = '';
			}
		}

		this.showNotification(_('Info'), _('Console disconnected'), 3000, 'info');
	},

	executeAction(ev, action, container_id) {
		ev?.preventDefault();

		const actionMap = Object.freeze({
			'start': _('Start'),
			'restart': _('Restart'),
			'stop': _('Stop'),
			'kill': _('Kill'),
			'pause': _('Pause'),
			'unpause': _('Unpause'),
			'remove': _('Remove'),
		});

		const actionLabel = actionMap[action] || action;

		// Confirm removal
		if (action === 'remove') {
			if (!confirm(_('Remove container?'))) {
				return;
			}
		}

		const view = this;
		const methodName = 'container_' + action;
		const method = dm2[methodName];

		if (!method) {
			view.showNotification(_('Error'), _('Action unavailable: ') + action, 7000, 'error');
			return;
		}

		view.executeDockerAction(
			method,
			{ id: container_id, query: {} },
			actionLabel,
			{
				showOutput: false,
				showSuccess: true,
				successMessage: actionLabel + _(' completed'),
				successDuration: 5000,
				onSuccess: () => {
					if (action === 'remove') {
						setTimeout(() => window.location.href = `${this.dockerman_url}/containers`, 1000);
					} else {
						setTimeout(() => location.reload(), 1000);
					}
				}
			}
		);
	},

	executeNetworkAction(action, networkID, networkName, this_container) {
		const view = this;

		if (action === 'disconnect') {
			if (!confirm(_('Disconnect network "%s" from container?').format(networkName))) {
				return;
			}

			view.executeDockerAction(
				dm2.network_disconnect,
				{
					id: networkID,
					body: { Container: view.containerId || this_container?.Id, Force: false }
				},
				_('Disconnect network'),
				{
					showOutput: false,
					showSuccess: true,
					successMessage: _('Network disconnected'),
					successDuration: 5000,
					onSuccess: () => {
						setTimeout(() => location.reload(), 1000);
					}
				}
			);
		} else if (action === 'connect') {
			const availableNetworks = Array.isArray(this.networks) ? this.networks : [];
			const connectedNames = Object.keys(this_container.NetworkSettings?.Networks || {});
			const newNetworks = availableNetworks.filter((n) => n?.Name && !connectedNames.includes(n.Name));

			if (newNetworks.length === 0) {
				view.showNotification(_('Info'), _('No additional networks available to connect'), 5000, 'info');
				return;
			}

			const selectableNetworks = {};
			// Create modal dialog for selecting network
			const networkSelect = E('select', { 
				'id': 'network-select',
				'class': 'cbi-input-select',
				'style': 'width:100%; margin-top:10px;'
			}, newNetworks.map(n => {
				const networkId = n.Id || n.Name;
				selectableNetworks[networkId] = n;
				const subnet0 = n?.IPAM?.Config?.[0]?.Subnet;
				const subnet1 = n?.IPAM?.Config?.[1]?.Subnet;
				return E('option', { 'value': networkId }, [`${n.Name}${n?.Driver ? ' | ' + n.Driver : ''}${subnet0 ? ' | ' + subnet0 : ''}${subnet1 ? ' | ' + subnet1 : ''}`]);
			}));

			const ip4Input = E('input', {
				'type': 'text',
				'id': 'network-ip4',
				'class': 'cbi-input-text',
				'placeholder': 'e.g., 172.18.0.5',
				'style': 'width:100%; margin-top:5px;'
			});

			const ip6Input = E('input', {
				'type': 'text',
				'id': 'network-ip6',
				'class': 'cbi-input-text',
				'placeholder': 'e.g., 2001:db8:1::1',
				'style': 'width:100%; margin-top:5px;'
			});

			const modalBody = E('div', { 'class': 'cbi-section' }, [
				E('p', {}, _('Select network to connect:')),
				networkSelect,
				E('label', { 'style': 'display:block; margin-top:10px;' }, _('IPv4 Address (optional):')),
				ip4Input,
				E('label', { 'style': 'display:block; margin-top:10px;' }, _('IPv6 Address (optional):')),
				ip6Input,
			]);

			ui.showModal(_('Connect Network'), [
				modalBody,
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'click': ui.hideModal
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'cbi-button cbi-button-positive',
						'click': () => {
							const selectedNetwork = networkSelect.value;
							const selectedNetworkObj = selectableNetworks[selectedNetwork];
							const ip4Address = (ip4Input.value || '').trim();
							const ip6Address = (ip6Input.value || '').trim();

							if (!selectedNetwork) {
								view.showNotification(_('Error'), [_('No network selected')], 5000, 'error');
								return;
							}

							ui.hideModal();

							const body = { Container: view.containerId || this_container?.Id };
							const networkName = selectedNetworkObj?.Name || '';
							const builtInNetworks = new Set(['none', 'bridge', 'host']);
							if (!builtInNetworks.has(networkName)) {
								const ipamConfig = {};
								if (ip4Address)
									ipamConfig.IPv4Address = ip4Address;
								if (ip6Address)
									ipamConfig.IPv6Address = ip6Address;
								if (Object.keys(ipamConfig).length)
									body.EndpointConfig = { IPAMConfig: ipamConfig };
							}

							view.executeDockerAction(
								dm2.network_connect,
								{ id: selectedNetwork, body: body },
								_('Connect network'),
								{
									showOutput: false,
									showSuccess: true,
									successMessage: _('Network connected'),
									successDuration: 5000,
									onSuccess: () => {
										setTimeout(() => location.reload(), 1000);
									}
								}
							);
						}
					}, _('Connect'))
				])
			]);
		}
	},

	// handleSave: null,
	handleSaveApply: null,
	handleReset: null,

});
