// LiveView hook that bridges Phoenix PubSub events to the React component.
// Register in Wanderer's app.js:
//   import NullsecIntelHook from "./nullsec/hooks/nullsecHook";
//   let Hooks = { ...existingHooks, NullsecIntelPanel: NullsecIntelHook };

const NullsecIntelHook = {
  mounted(this: { el: HTMLElement; handleEvent: Function; pushEvent: Function }) {
    const systemId = this.el.dataset.systemId;
    if (!systemId) return;

    // Listen for PubSub events pushed from the LiveView process
    this.handleEvent("nullsec_intel_update", (data: { data: unknown[] }) => {
      window.dispatchEvent(
        new CustomEvent(`nullsec_intel_update_${systemId}`, { detail: data })
      );
    });

    // Request initial data load
    this.pushEvent("load_nullsec_intel", { system_id: parseInt(systemId, 10) });
  },

  destroyed() {
    // Cleanup handled by React's useEffect return
  },
};

export default NullsecIntelHook;
