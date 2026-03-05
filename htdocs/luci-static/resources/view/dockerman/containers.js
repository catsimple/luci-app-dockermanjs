'use strict';
'require form';
'require fs';
'require poll';
'require ui';
'require dockerman.common as dm2';

/*
Copyright 2026
Docker manager JS for Luci by Paul Donald <newtwen+github@gmail.com> 
Based on Docker Lua by lisaac <https://github.com/lisaac/luci-app-dockerman>
LICENSE: GPLv2.0
*/

/* API v1.52:

GET /containers/{id}/json: the NetworkSettings no longer returns the deprecated
 Bridge, HairpinMode, LinkLocalIPv6Address, LinkLocalIPv6PrefixLen,
 SecondaryIPAddresses, SecondaryIPv6Addresses, EndpointID, Gateway,
 GlobalIPv6Address, GlobalIPv6PrefixLen, IPAddress, IPPrefixLen, IPv6Gateway,
 and MacAddress fields. These fields were deprecated in API v1.21 (docker
 v1.9.0) but kept around for backward compatibility.

*/

return dm2.dv.extend({
	load() {
		return Promise.all([
			dm2.container_list({query: {all: true}}),
			dm2.image_list({query: {all: true}}),
			dm2.network_list({query: {all: true}}),
		]);
	},

	render([containers, images, networks]) {
		if (containers?.code !== 200) {
			return E('div', {}, [ containers?.body?.message ]);
		}

		let container_list = containers.body;
		let network_list = networks.body;
		let image_list = images.body;

		const view = this;
		let containerTable;


		const m = new form.JSONMap({container: view.getContainersTable(container_list, image_list, network_list), prune: {}},
			_('Docker - Containers'),
			_('This page displays all docker Containers that have been created on the connected docker host.') + '<br />' +
			_('Note: docker provides no container import facility.'));
		m.submit = false;
		m.reset = false;

		let s, o;


		let pollPending = null;
		let conSec = null;
		const calculateTotals = () => {
			return {
				running_total: Array.isArray(container_list) ?
					container_list.filter(c => c?.State === 'running').length : 0,
				paused_total: Array.isArray(container_list) ?
					container_list.filter(c => c?.State === 'paused').length : 0,
				stopped_total: Array.isArray(container_list) ?
					container_list.filter(c => ['exited', 'created'].includes(c?.State)).length : 0
			};
		};

		const refresh = () => {
			if (pollPending) return pollPending;
			pollPending = view.load().then(([containers2, images2, networks2]) => {
				image_list = images2.body;
				container_list = containers2.body;
				network_list = networks2.body;
				m.data = new m.data.constructor({ container: view.getContainersTable(container_list, image_list, network_list), prune: {} });

				const totals = calculateTotals();
				if (conSec) {
					conSec.footer = [
						`${_('Total')} ${container_list.length}`,
						[
							`${_('Running')} ${totals.running_total}`,
							E('br'),
							`${_('Paused')} ${totals.paused_total}`,
							E('br'),
							`${_('Stopped')} ${totals.stopped_total}`,
						],
						'',
						'',
					];
				}
				
				return m.render();
			}).catch((err) => { console.warn(err) }).finally(() => { pollPending = null });
			return pollPending;
		};
		this.refreshContainers = refresh;

		s = m.section(form.TableSection, 'prune', _('Containers overview'), null);
		s.addremove = false;
		s.anonymous = true;

		const prune = s.option(form.Button, '_prune', null);
		prune.inputtitle = `${dm2.ActionTypes['prune'].i18n} ${dm2.ActionTypes['prune'].e}`;
		prune.inputstyle = 'negative';
		prune.onclick = L.bind(function(section_id, ev) {
			return this.super('handleXHRTransfer', [{
				q_params: {  },
				commandCPath: '/containers/prune',
				commandDPath: '/containers/prune',
				commandTitle: dm2.ActionTypes['prune'].i18n,
				onUpdate: (msg) => {
					try {
						if (msg?.error) {
							view.showNotification(dm2.ActionTypes['prune'].i18n, msg.error, 7000, 'error');
							return;
						}

						if (msg?.ContainersDeleted || msg?.SpaceReclaimed != null) {
							const deleted = Array.isArray(msg.ContainersDeleted) ? msg.ContainersDeleted.length : 0;
							const reclaimed = msg.SpaceReclaimed != null ? `%1024.2m`.format(msg.SpaceReclaimed) : '0B';
							view.showNotification(
								dm2.ActionTypes['prune'].i18n,
								_('Deleted: %s, Reclaimed: %s').format(deleted, reclaimed),
								5000,
								'success'
							);
						}
					} catch { }
				},
				noFileUpload: true,
			}]);
		}, this);

		const totals = calculateTotals();
		let running_total = totals.running_total;
		let paused_total = totals.paused_total;
		let stopped_total = totals.stopped_total;

		conSec = m.section(form.TableSection, 'container');
		conSec.anonymous = true;
		conSec.nodescriptions = true;
		conSec.addremove = true;
		conSec.sortable = true;
		conSec.filterrow = true;
		conSec.addbtntitle = `${dm2.ActionTypes['create'].i18n} ${dm2.ActionTypes['create'].e}`;
		conSec.footer = [
			`${_('Total')} ${container_list.length}`,
			[
				`${_('Running')} ${running_total}`,
				E('br'),
				`${_('Paused')} ${paused_total}`,
				E('br'),
				`${_('Stopped')} ${stopped_total}`,
			],
			'',
			'',
		];

		conSec.handleAdd = function(section_id, ev) {
			window.location.href = `${view.dockerman_url}/container_new`;
		};

		conSec.renderRowActions = function(sid) {
			const cont = this.map.data.data[sid];
			return view.buildContainerActions(cont);
		}

		o = conSec.option(form.DummyValue, 'cid', _('Container'));
		o = conSec.option(form.DummyValue, 'State', _('State'));
		o = conSec.option(form.DummyValue, 'Networks', _('Networks'));
		o.rawhtml = true;
		o = conSec.option(form.DummyValue, 'Ports', _('Ports'));
		o.rawhtml = true;
		o = conSec.option(form.DummyValue, 'Command', _('Command'));
		o.width = 200;
		o = conSec.option(form.DummyValue, 'Created', _('Created'));

		poll.add(L.bind(() => { refresh(); }, this), 10);

		return m.render();

	},

	buildContainerActions(cont, idx) {
		const view = this;
		const isRunning = cont?.State === 'running';
		const isPaused = cont?.State === 'paused';
		const run = (ev, apiMethod, params, actionName, options = {}) =>
			view.runContainerAction(ev, apiMethod, params, actionName, options);

		const btns = [
			E('button', {
				'class': 'cbi-button view',
				'title': dm2.ActionTypes['inspect'].i18n,
				'click': (ev) => run(
					ev,
					dm2.container_inspect,
					{id: cont.Id},
					dm2.ActionTypes['inspect'].i18n,
					{
						showOutput: false,
						showSuccess: false,
						refreshOnSuccess: false,
						onSuccess: (response) => ui.showModal(_('Container Inspect'), [
							E('pre', {
								'style': 'max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word;'
							}, JSON.stringify(response?.body || {}, null, 2)),
							E('div', { 'class': 'right' }, [
								E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, _('Close'))
							])
						])
					}
				)
			}, [dm2.ActionTypes['inspect'].e]),

			E('button', {
				'class': 'cbi-button cbi-button-positive edit',
				'title': _('Edit this container'),
				'click': () => window.location.href = `${view.dockerman_url}/container/${cont?.Id}`
			}, [dm2.ActionTypes['edit'].e]),

			(() => {
				const icon = isRunning
					? dm2.Types['container'].sub['pause'].e
					: (isPaused 
						? dm2.Types['container'].sub['unpause'].e
						: dm2.Types['container'].sub['start'].e);
				const title = isRunning
					? _('Pause this container')
					: (isPaused ? _('Unpause this container') : _('Start this container'));
				const handler = isRunning
					? (ev) => run(
							ev,
							dm2.container_pause,
							{id: cont.Id},
							dm2.Types['container'].sub['pause'].i18n,
							{showOutput: false}
						)
					: (isPaused ? (ev) => run(
							ev,
							dm2.container_unpause,
							{id: cont.Id},
							dm2.Types['container'].sub['unpause'].i18n,
							{showOutput: false}
						) : (ev) => run(
							ev,
							dm2.container_start,
							{id: cont.Id},
							dm2.Types['container'].sub['start'].i18n,
							{showOutput: false}
						));
				const btnClass = isRunning ? 'cbi-button cbi-button-neutral' : 'cbi-button cbi-button-positive start';

				return E('button', {
					'class': btnClass,
					'title': title,
					'click': handler,
				}, [icon]);
			})(),

			E('button', {
				'class': 'cbi-button cbi-button-neutral restart',
				'title': _('Restart this container'),
				'click': (ev) => run(
					ev,
					dm2.container_restart,
					{id: cont.Id},
					_('Restart'),
					{showOutput: false}
				)
			}, [dm2.Types['container'].sub['restart'].e]),

			E('button', {
				'class': 'cbi-button cbi-button-neutral stop',
				'title': _('Stop this container'),
				'click': (ev) => run(
					ev,
					dm2.container_stop,
					{id: cont.Id},
					dm2.Types['container'].sub['stop'].i18n,
					{showOutput: false}
				),
				'disabled' : !(isRunning || isPaused) ? true : null
			}, [dm2.Types['container'].sub['stop'].e]),

			E('button', {
				'class': 'cbi-button cbi-button-negative kill',
				'title': _('Kill this container'),
				'click': (ev) => run(
					ev,
					dm2.container_kill,
					{id: cont.Id},
					dm2.Types['container'].sub['kill'].i18n,
					{
						showOutput: false,
						confirmMessage: _('Kill this container?')
					}
				),
				'disabled' : !(isRunning || isPaused) ? true : null
			}, [dm2.Types['container'].sub['kill'].e]),

			E('button', {
				'class': 'cbi-button cbi-button-neutral export',
				'title': _('Export this container'),
				'click': () => {
					window.location.href = `${view.dockerman_url}/container/export/${cont.Id}`;
				}
			}, [dm2.Types['container'].sub['export'].e]),

			E('div', {
				'style': 'width: 20px',
				// Some safety margin for mis-clicks
			}, [' ']),

			E('button', {
				'class': 'cbi-button cbi-button-negative remove',
				'title': dm2.ActionTypes['remove'].i18n,
				'click': (ev) => run(
					ev,
					dm2.container_remove,
					{id: cont.Id, query: { force: false }},
					dm2.ActionTypes['remove'].i18n,
					{
						showOutput: false,
						confirmMessage: _('Remove container?')
					}
				)
			}, [dm2.ActionTypes['remove'].e]),

			E('button', {
				'class': 'cbi-button cbi-button-negative important remove',
				'title': dm2.ActionTypes['force_remove'].i18n,
				'click': (ev) => run(
					ev,
					dm2.container_remove,
					{id: cont.Id, query: { force: true }},
					_('Force Remove'),
					{
						showOutput: false,
						confirmMessage: _('Force remove container?')
					}
				)
			}, [dm2.ActionTypes['force_remove'].e]),
		];

		return E('td', { 
			'class': 'td',
		}, E('div', btns));
	},

	setActionButtonBusy(button, busy, busyText = '...') {
		if (!button)
			return;

		if (busy) {
			button.dataset.busy = '1';
			button.dataset.origText = button.textContent || '';
			button.disabled = true;
			button.textContent = busyText;
			button.style.opacity = '0.65';
			return;
		}

		button.disabled = false;
		button.textContent = button.dataset.origText || button.textContent;
		button.style.opacity = '';
		delete button.dataset.origText;
		delete button.dataset.busy;
	},

	async runContainerAction(ev, apiMethod, params, actionName, options = {}) {
		const {
			confirmMessage = null,
			refreshOnSuccess = true,
			...execOptions
		} = options;

		const button = ev?.currentTarget;
		if (button?.dataset?.busy === '1')
			return false;

		if (confirmMessage && !confirm(confirmMessage))
			return false;

		this.setActionButtonBusy(button, true);
		this.showNotification(actionName, _('Processing...'), 1200, 'info');

		const ok = await this.executeDockerAction(apiMethod, params, actionName, {
			showOutput: false,
			showSuccess: true,
			...execOptions,
		});

		this.setActionButtonBusy(button, false);

		if (ok && refreshOnSuccess && typeof this.refreshContainers === 'function') {
			await this.refreshContainers();
		}

		return ok;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	getContainersTable(containers, image_list, network_list) {
		const data = [];

		for (const cont of Array.isArray(containers) ? containers : []) {

			// build Container ID: xxxxxxx image: xxxx
			const names = Array.isArray(cont?.Names) ? cont.Names : [];
			const cleanedNames = names
				.map(n => (typeof n === 'string' ? n.substring(1) : ''))
				.filter(Boolean)
				.join(', ');
			const statusColorName = this.wrapStatusText(cleanedNames, cont.State, 'font-weight:600;');
			const imageName = this.getImageFirstTag(image_list, cont.ImageID);
			const shortId = (cont?.Id || '').substring(0, 12);

			const cid = E('div', {}, [
					E('a', { href: `container/${cont.Id}`, title: dm2.ActionTypes['edit'].i18n }, [
						statusColorName,
						E('div', { 'style': 'font-size: 0.9em; font-family: monospace; ' }, [`ID: ${shortId}`]),
					]),
				E('div', { 'style': 'font-size: 0.85em;' }, [`${dm2.Types['image'].i18n}: ${imageName}`]),
			])

			// Just push plain data objects without UCI metadata
			data.push({
				...cont,
				cid: cid,
				_shortId: (cont?.Id || '').substring(0, 12),
				Networks: this.parseNetworkLinksForContainer(network_list, cont?.NetworkSettings?.Networks || {}, true),
				Created: this.buildTimeString(cont?.Created) || '',
				Ports: (Array.isArray(cont.Ports) && cont.Ports.length > 0)
						? cont.Ports.map(p => {
							// const ip = p.IP || '';
							const pub = p.PublicPort || '';
							const priv = p.PrivatePort || '';
							const type = p.Type || '';
							return `${pub ? pub + ':' : ''}${priv}/${type}`;
							// return `${ip ? ip + ':' : ''}${pub} -> ${priv} (${type})`;
						}).join('<br/>')
						: '',
			});
		}

		return data;
	},

});
