module.exports = {
  async getTimers({ homey }) {
    return homey.app.exportTimers();
  },

  async deleteTimer({ homey, params }) {
    return homey.app.cancelTimerById(params.id);
  },

  async getTimerActivity({ homey }) {
    return homey.app.exportTimerActivity();
  },

  async clearTimerActivity({ homey }) {
    return homey.app.clearTimerActivity();
  },
};
