angular.module('TimerApp',['smart-table'])
    .controller('TimerSettingsController', ($scope, $timeout) => {
        var homey;
        $scope.timers = {};
        $scope.settings = {
            timelineDebugEnabled: false,
        };
        $scope.ui = {};

        const safeApply = () => {
            if (!$scope.$$phase) {
                $scope.$digest();
            }
        };

        $scope.initHomey = (homey) => {
            this.homey = homey;
            $scope.ui = {
                debugTitle: this.homey.__('settings.debug_title'),
                debugLabel: this.homey.__('settings.debug_label'),
                debugHint: this.homey.__('settings.debug_hint'),
                saveSettings: this.homey.__('settings.save'),
                settingsSaved: this.homey.__('settings.saved'),
            };

            this.homey.get('timeline_debug_enabled', (err, result) => {
                if (err) return this.homey.alert(err);

                $scope.settings.timelineDebugEnabled = result === true;
                safeApply();
            });

            // listen to add timer event
            this.homey.on('timer_started', (addedTimer) => {
                $scope.updateTimers(addedTimer.timers);
            });

            // listen to delete timer event
            this.homey.on('timer_deleted', (deletedTimer) => {
                $scope.updateTimers(deletedTimer.timers);
            });

            // get current state of timers
            this.homey.api('GET', '/timers', null, (err, result) => {
                if (err) return this.homey.alert(err);
               
                $scope.updateTimers(result);
            });
        };

        $scope.updateTimers = (timers) => {
            $scope.timers = timers;

            $scope.renderTimers();
        }

        $scope.renderTimers = () => {

            // filter expired timers, when delete event hasn't been received
            $scope.timers = Object.keys($scope.timers)
                .filter(key => $scope.remainingInSeconds($scope.timers[key].offTime) >= 0) 
                .reduce((newTimers, key) => {
                    newTimers[key] = $scope.timers[key];
                    return newTimers;
                }, {});


            safeApply();

            // keep refreshing, as long as there are timers
            if (Object.keys($scope.timers).length) {
                $timeout( function() {
                    $scope.renderTimers();
                }, 1000);
            }
        }

        //remove to the real data holder
        $scope.cancelTimer = (deviceId) => {
            this.homey.api('DELETE', `/timers/${deviceId}`, null, function( err, result ) {
                if (err) return this.homey.alert(err);
            });
        }

        $scope.saveSettings = () => {
            this.homey.set('timeline_debug_enabled', !!$scope.settings.timelineDebugEnabled, (err) => {
                if (err) return this.homey.alert(err);

                this.homey.alert($scope.ui.settingsSaved);
            });
        }

        $scope.showDetails  = (timer) => {
            $scope.detail = timer;
        }

        $scope.getTemplate = (timer) => {
            return 'display';
            //TODO: return 'edit';
        };

        // calculate remaining seconds
        $scope.remainingInSeconds = (time) => {
            return Math.round((time - new Date().getTime())/1000);
        }

    })
;
