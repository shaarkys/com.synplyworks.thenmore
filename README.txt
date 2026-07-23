# Timer - add Timers to temporarily turn on devices

*FKA Then More

This app adds More functionality to the Then... clause of your flows, to be able to turn (dimmed) devices on for a period of time.

## How does it work?
* Create a flow with for example a motion sensor, but basically anything you like as a trigger in the When... clause
* Add a Timer-card to the Then... clause of your flow
  * Select an OnOff device, or scroll to the Dimable device card
  * Enter the amount of seconds to keep the device on
  * You can configure to not activate the device (with the associated off timer), when the device is already on.
  * When you have multiple flows, activating the same device, but with different durations, you can also define to set the duration to the current configured time, even when it's shorter than the time left in the running timer.

When the flow (or another flow with the same device entered in the Timer card) is triggered again, the timer gets reset, and the device is kept on for a longer period of time.

Feel free to add multiple Timer-cards in the same flow, or select the same device in more than one flow via the Timer-cards.

For more info, see: https://community.athom.com/t/timer-v0-4-3-stable-homey-v1-5-0-6-1-beta-homey-v2-fka-then-more-add-timers-to-temporarily-turn-on-devices/3722


## Todo
* Find a way to handle motion started/ended triggers better, since with continuous motion, the timer will end sooner than (maybe even before) the last motion.
