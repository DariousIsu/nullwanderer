import time
import math
from agent import Agent
from belief import Belief
from goal import Goal
from emotion import Emotion

'''
Gamydala emotion engine
Python Port
Original code: https://github.com/broekens/gamygdala
'''
class Gamygdala:
    def __init__(self):
        self.agents = []
        self.goals = []
        self.decay_function = self.exponential_decay
        self.decay_factor = 0.8
        self.last_millis = int(time.time() * 1000)
        self.millis_passed = 0
        self.debug = False

    '''
    Method create_agent
    A facilitator method that creates a new Agent and registers it for you
    Params:
    * agent_name: The agent with agentName is created
    return {Agent}: An agent reference to the newly created agent
    '''
    def create_agent(self, agent_name):
        agent = Agent(agent_name)
        self.register_agent(agent)
        return agent

    '''
    method create_goal_for_agent
    A facilitator method to create a goal for a particular agent, that also registers the goal to the agent and gamygdala.
    This method is thus handy if you want to keep all gamygdala logic internal to Gamygdala.
    However, if you want to do more sophisticated stuff (e.g., goals for multiple agents, keep track of your own list of goals to also remove them, appraise events per agent without the need for gamygdala to keep track of goals, etc...) this method will probably be doing too much.
    Params:
    * agent_name: The agent's name to which the newly created goal has to be added.
    * goal_name: The goal's name.
    * goal_utility: The goal's utility.
    * is_maintenance_goal: Defines if the goal is a maintenance goal or not [optional]. The default is that the goal is an achievement goal, i.e., a goal that once it's likelihood reaches true (1) or false (-1) stays that way.
    return {Goal} a goal reference to the newly created goal.
    '''
    def create_goal_for_agent(self, agent_name, goal_name, goal_utility, is_maintenance_goal=False):
        temp_agent = self.get_agent_by_name(agent_name)
        if temp_agent:
            temp_goal = self.get_goal_by_name(goal_name)

            if temp_goal:
                print(f"Warning: I cannot make a new goal with the same name {goal_name} as one is registered already. I assume the goal is a common goal and will add the already known goal with that name to the agent {agent_name}")
            else:
                temp_goal = Goal(goal_name, goal_utility)
                self.register_goal(temp_goal)

            temp_agent.add_goal(temp_goal)

            if is_maintenance_goal:
                temp_goal.is_maintenance_goal = is_maintenance_goal
            return temp_goal
        else:
            print(f"Error: agent with name {agent_name} does not exist, so I cannot create a goal for it.")
            return None

    '''
    method create_relation
    A facilitator method to create a relation between two agents. Both source and target have to exist and be registered with this Gamygdala instance.
    This method is thus handy if you want to keep all gamygdala logic internal to Gamygdala.
    Params:
    * source_name: The agent who has the relation (the source)
    * target_name: The agent who is the target of the relation (the target)
    * relation: The relation (between -1 and 1).
    '''
    def create_relation(self, source_name, target_name, relation):
        source = self.get_agent_by_name(source_name)
        target = self.get_agent_by_name(target_name)
        if source and target and -1 <= relation <= 1:
            source.update_relation(target_name, relation)
        else:
            print(f'Error: cannot relate {source} to {target} with intensity {relation}')

    '''
    method appraise_belief
    A facilitator method to appraise an event. It takes in the same as what the new Belief(...) takes in, creates a belief and appraises it for all agents that are registered.
    This method is thus handy if you want to keep all gamygdala logic internal to Gamygdala.
    Params:
    * likelihood: The likelihood of this belief to be true.
    * causal_agent_name: The agent's name of the causal agent of this belief.
    * affected_goal_names: An array of affected goals' names.
    * goal_congruences: An array of the affected goals' congruences (i.e., the extend to which this event is good or bad for a goal [-1,1]).
    * is_incremental: Incremental evidence enforces gamygdala to see this event as incremental evidence for (or against) the list of goals provided, i.e, it will add or subtract this belief's likelihood*congruence from the goal likelihood instead of using the belief as "state" defining the absolute likelihood
    '''
    def appraise_belief(self, likelihood, causal_agent_name, affected_goal_names, goal_congruences, is_incremental=False):
        temp_belief = Belief(likelihood, causal_agent_name, affected_goal_names, goal_congruences, is_incremental)
        #self.appraise(temp_belief)
        self.appraise_all(temp_belief)

    '''
    method print_all_emotions
    Facilitator method to print all emotional states to the console.	
    Param:
    * gain: Whether you want to print the gained (true) emotional states or non-gained (false).
    '''
    def print_all_emotions(self, gain):
        for agent in self.agents:
            agent.print_emotional_state(gain)
            agent.print_relations(None)

    '''
    method set_gain
    Facilitator to set the gain for the whole set of agents known to Gamygdala.
    For more realistic, complex games, you would typically set the gain for each agent type separately, to finetune the intensity of the response.
    Param:
    * gain: The gain value [0 and 20].
    '''
    def set_gain(self, gain):
        for agent in self.agents:
            agent.set_gain(gain)

    '''
    method set_decay
    Sets the decay factor and function for emotional decay.
    It sets the decay factor and type for emotional decay, so that an emotion will slowly get lower in intensity.
    Whenever decayAll is called, all emotions for all agents are decayed according to the factor and function set here.
    Params:
    * decay_factor: The decay factor used. A factor of 1 means no decay, a factor 
    * decay_function: The decay function to be used. Choose between linearDecay or exponentialDecay (see the corresponding methods)
    '''
    def set_decay(self, decay_factor, decay_function):
        self.decay_function = decay_function
        self.decay_factor = decay_factor

    '''
    This starts the actual gamygdala decay process. It simply calls decayAll() at the specified interval.
    The time_ms only defines the interval at which to decay, not the rate over time, that is defined by the decay_factor and function.
    For more complex games (e.g., games where agents are not active when far away from the player, or games that do not need all agents to decay all the time) you should yourself choose when to decay agents individually.
    To do so you can simply call the agent.decay() method (see the agent class).
    Param:
    * time_ms: The "framerate" of the decay in milliseconds. 
    '''
    def start_decay(self, time_ms):
        import threading
        threading.Timer(time_ms / 1000, self.decay_all).start()

    '''
    ///////////////////////////////////////////////////////////////////////
    //Below this is more detailed gamygdala stuff to use it more flexibly.
    ///////////////////////////////////////////////////////////////////////
    '''
    def register_agent(self, agent):
        self.agents.append(agent)
        agent.gamygdala_instance = self

    def get_agent_by_name(self, agent_name):
        for agent in self.agents:
            if agent.name == agent_name:
                return agent
        print(f'Warning: agent {agent_name} not found')
        return None

    def register_goal(self, goal):
        # TO CHECK: get_goal_by_name already checked?
        if self.get_goal_by_name(goal.name) is None:
            self.goals.append(goal)
        else:
            print(f"Warning: failed adding a second goal with the same name: {goal.name}")

    def get_goal_by_name(self, goal_name):
        for goal in self.goals:
            if goal.name == goal_name:
                return goal
        return None

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Appraise
    These methods is the main emotional interpretation logic entry point. It performs the complete appraisal of a single event (belief) for all agents (appraise_all) or for only one agent (appraise_agent)
    this is sometimes needed for efficiency, if you as a game developer know that particular agents can never appraise an event, then you can force Gamygdala to only look at a subset of agents.
    Gamygdala assumes that the affected_agent is indeed the only goal owner affected, that the belief is well-formed, and will not perform any checks, nor use Gamygdala's list of known goals to find other agents that share this goal (!!!)
    Params:
    * belief: The current event, in the form of a Belief object, to be appraised
    * affected_agent: The reference to the agent who needs to appraise the event. If given, this is the appraisal perspective (see explanation above).
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''

    '''
    Appraise a specific agent
    '''
    def appraise_agent(self, belief, affected_agent):
        # check only affected_agent (which can be much faster) and does not involve console output nor checks
        for i, goal_name in enumerate(belief.affected_goal_names):
            # Loop through every goal in the list of affected goals by this event.
            current_goal = affected_agent.get_goal_by_name(goal_name)
            utility = current_goal.utility
            delta_likelihood = self.calculate_delta_likelihood(current_goal, belief.goal_congruences[i], belief.likelihood, belief.is_incremental)
            desirability = delta_likelihood * utility

            # assume affected_agent is the only owner to be considered in this appraisal round.
            owner = affected_agent

            self.evaluate_internal_emotion(utility, delta_likelihood, current_goal.likelihood, owner)
            self.agent_actions(owner.name, belief.causal_agent_name, owner.name, desirability, utility, delta_likelihood)

            # now check if anyone has a relation to this goal owner, and update the social emotions accordingly.
            for agent in self.agents:
                relation = agent.get_relation(owner.name)
                if relation is not None:
                    if self.debug:
                        print(f'{agent.name} has a relationship with {owner.name}')
                        print(relation)

                    # The agent has relationship with the goal owner which has nonzero utility, add relational effects to the relations for agent[k].
                    self.evaluate_social_emotion(utility, desirability, delta_likelihood, relation, agent)

                    # also add remorse and gratification if conditions are met within (i.e., agent[k] did something bad/good for owner)
                    self.agent_actions(owner.name, belief.causal_agent_name, agent.name, desirability, utility, delta_likelihood)
                else:
                    if self.debug:
                        print(f'{agent.name} has NO relationship with {owner.name}')

    '''
    Appraise all agents
    '''
    def appraise_all(self, belief):
        # check all
        if self.debug:
            print(belief)

        if len(belief.goal_congruences) != len(belief.affected_goal_names):
            print("Error: the congruence list was not of the same length as the affected goal list")
            print(belief.goal_congruences)
            print(belief.affected_goal_names)
            return False  # The congruence list must be of the same length as the affected goals list.

        if len(self.goals) == 0:
            print("Warning: no goals registered to Gamygdala, all goals to be considered in appraisal need to be registered.")
            return False  # No goals registered to GAMYGDALA.

        # Loop through every goal in the list of affected goals by this event.
        for i, goal_name in enumerate(belief.affected_goal_names):
            current_goal = self.get_goal_by_name(goal_name)

            if current_goal is not None:
                # the goal exists, appraise it
                utility = current_goal.utility
                delta_likelihood = self.calculate_delta_likelihood(current_goal, belief.goal_congruences[i], belief.likelihood, belief.is_incremental)
                desirability = delta_likelihood * utility

                if self.debug:
                    print(f"Desirability = {desirability:.2f}")

                # now find the owners, and update their emotional states
                for owner in self.agents:
                    #if agent.has_goal(current_goal.name):
                    #    owner = agent

                    # Fix 10/10/2024 : evaluate emotions only if agent has a goal 
                    if owner.has_goal(current_goal.name):
                        if self.debug:
                            print(f'....owned by {owner.name}')
                        self.evaluate_internal_emotion(utility, delta_likelihood, current_goal.likelihood, owner)
                        self.agent_actions(owner.name, belief.causal_agent_name, owner.name, desirability, utility, delta_likelihood)

                    # now check if anyone has a relation to this goal owner, and update the social emotions accordingly.
                    for other_agent in self.agents:
                        relation = other_agent.get_relation(owner.name)
                        if relation is not None:
                            if self.debug:
                                print(f'{other_agent.name} has a relationship with {owner.name}')
                                print(relation)

                                # The agent has relationship with the goal owner which has nonzero utility, add relational effects to the relations for agent[k].
                                self.evaluate_social_emotion(utility, desirability, delta_likelihood, relation, other_agent)

                                # also add remorse and gratification if conditions are met within (i.e., agent[k] did something bad/good for owner)
                                self.agent_actions(owner.name, belief.causal_agent_name, other_agent.name, desirability, utility, delta_likelihood)
                            else:
                                if self.debug:
                                    print(f'{other_agent.name} has NO relationship with {owner.name}')

        # print the emotions to the console for debugging
        if self.debug:
            self.print_all_emotions(True)

    def calculate_delta_likelihood(self, goal, congruence, belief_likelihood, is_incremental):
        # Defines the change in a goal's likelihood due to the congruence and likelihood of a current event.
        # We cope with two types of beliefs: incremental and absolute beliefs. Incrementals have their likelihood added to the goal, absolute define the current likelihood of the goal
        # And two types of goals: maintenance and achievement. If an achievement goal (the default) is -1 or 1, we can't change it any more (unless externally and explicitly by changing the goal.likelihood).
        old_likelihood = goal.likelihood
        new_likelihood = None

        # Added bug Fix : if not goal.is_maintenance_goal and (old_likelihood >= 1 or old_likelihood <= -1):
        if not goal.is_maintenance_goal and old_likelihood is not None and (old_likelihood >= 1 or old_likelihood <= 0):
            return 0

        if hasattr(goal, 'calculate_likelihood') and callable(goal.calculate_likelihood):
            # If the goal has an associated function to calculate the likelihood that the goal is true, then use that function
            new_likelihood = goal.calculate_likelihood()
        else:
            # Otherwise use the event encoded updates
            # Added bug Fix : check for old_likelihood is Not None
            if is_incremental and old_likelihood is not None:
                new_likelihood = old_likelihood + belief_likelihood * congruence
                # Added Joost fix 07/10/2024 : new_likelihood = max(min(new_likelihood, 1), -1)
                new_likelihood = max(min(new_likelihood, 1), 0)
            else:
                new_likelihood = (congruence * belief_likelihood + 1.0) / 2.0

        goal.likelihood = new_likelihood
        if self.debug:
            print(f"Updated Goal likelihood = {new_likelihood:.2f}")

        if old_likelihood is not None:
            if self.debug:
                print(f"Goal Delta likelihood = {new_likelihood - old_likelihood:.2f}")
            return new_likelihood - old_likelihood
        else:
            if self.debug:
                print(f"Goal likelihood: new = {new_likelihood:.2f}")
            return new_likelihood
    
    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Internal Consequence of Events
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def evaluate_internal_emotion(self, utility, delta_likelihood, goal_likelihood, agent):
        # This method evaluates the event in terms of internal emotions that do not need relations to exist, such as hope, fear, etc.
        positive = False
        intensity = 0
        emotion = []

        # if goal likelihood is not confirmed, emotions is between hope and fear depending on utility
        if utility >= 0:
            positive = delta_likelihood >= 0
        else:
            positive = delta_likelihood < 0

        if 0 < goal_likelihood < 1:
            emotion.append('hope' if positive else 'fear')

        # if goal likelihood == 1 (desired) emotion between joy and distress depends on utility
        elif goal_likelihood == 1:
            if utility >= 0:
                if delta_likelihood < 0.5:
                    emotion.append('satisfaction')
                emotion.append('joy')
            else:
                if delta_likelihood < 0.5:
                    emotion.append('fear-confirmed')
                emotion.append('distress')

        # if goal likelihood == 0 (not desired) emotion between distress and joy depends on utility
        elif goal_likelihood == 0:
            if utility >= 0:
                # Joost fix 07/10/2024 for if delta_likelihood > 0.5:
                if delta_likelihood < -0.5:
                    emotion.append('disappointment')
                emotion.append('distress')
            else:
                # Joost fix 07/10/2024 for if delta_likelihood > 0.5:
                if delta_likelihood < -0.5:
                    emotion.append('relief')
                emotion.append('joy')

        intensity = abs(utility * delta_likelihood)

        if self.debug:
            print(f"Internal emotion intensity = {intensity:.2f}")

        if intensity != 0:
            for emotion_name in emotion:
                agent.update_emotional_state(Emotion(emotion_name, intensity))

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Social Consequence of Events
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def evaluate_social_emotion(self, utility, desirability, delta_likelihood, relation, agent):
        # This function is used to evaluate happy-for, pity, gloating or resentment.
        # Emotions that arise when we evaluate events that affect goals of others.
        # The desirability is the desirability from the goal owner's perspective.
        # The agent is the agent getting evaluated (the agent that gets the social emotion added to his emotional state).
        # The relation is a relation object between the agent being evaluated and the goal owner of the affected goal.

        if self.debug:
            print(f"Social Emotion: Desirability = {desirability:.2f}, Relation.like = {relation.like:.2f}")

        emotion = Emotion(None, None)
            
        if desirability >= 0:
            if relation.like >= 0:
                emotion.name = 'happy-for'
            else:
                emotion.name = 'resentment'
        else:
            if relation.like >= 0:
                emotion.name = 'pity'
            else:
                emotion.name = 'gloating'
            
        emotion.intensity = abs(utility * delta_likelihood * relation.like)

        if self.debug:
            print(f"Social emotion intensity = {emotion.intensity:.2f}")

        if emotion.intensity != 0:
            relation.add_emotion(emotion)
            agent.update_emotional_state(emotion)  # also add relation emotion to the emotional state

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Actions of Agents
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def agent_actions(self, affected_name, causal_name, self_name, desirability, utility, delta_likelihood):
        if causal_name is not None and causal_name != '':
            # If the causal agent is null or empty, then we assume the event was not caused by an agent.
            # There are three cases here:
            # 1. The affected agent is SELF and causal agent is other.
            # 2. The affected agent is SELF and causal agent is SELF.
            # 3. The affected agent is OTHER and causal agent is SELF.
            emotion = Emotion(None, None)
                
            if affected_name == self_name and self_name != causal_name:
                # Case one : SELF-OTHER
                if desirability >= 0:
                    emotion.name = 'gratitude'
                else:
                    emotion.name = 'anger'
                    
                emotion.intensity = abs(utility * delta_likelihood)
                self_agent = self.get_agent_by_name(self_name)
                    
                if self_agent.has_relation_with(causal_name):
                    relation = self_agent.get_relation(causal_name)
                else:
                    self_agent.update_relation(causal_name, 0.0)
                    relation = self_agent.get_relation(causal_name)
                    
                relation.add_emotion(emotion)
                self_agent.update_emotional_state(emotion)  # also add relation emotion to the emotional state
                
            elif affected_name == self_name and self_name == causal_name:
                    # Case two : SELF-SELF
                    # This case is not included in Gamygdala.
                    # This should include pride and shame
                    pass
                
            elif affected_name != self_name and causal_name == self_name:
                # Case three : OTHER-SELF
                causal_agent = self.get_agent_by_name(causal_name)
                if causal_agent.has_relation_with(affected_name):
                    relation = causal_agent.get_relation(affected_name)
                    if desirability >= 0:
                        if relation.like >= 0:
                            emotion.name = 'gratification'
                            emotion.intensity = abs(utility * delta_likelihood * relation.like)
                            relation.add_emotion(emotion)
                            causal_agent.update_emotional_state(emotion)  # also add relation emotion to the emotional state
                    else:
                        if relation.like >= 0:
                            emotion.name = 'remorse'
                            emotion.intensity = abs(utility * delta_likelihood * relation.like)
                            relation.add_emotion(emotion)
                            causal_agent.update_emotional_state(emotion)  # also add relation emotion to the emotional state

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Decay methods
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def decay_all(self):
        self.millis_passed = int(time.time() * 1000) - self.last_millis
        self.last_millis = int(time.time() * 1000)
        for agent in self.agents:
            agent.decay(self)

    def linear_decay(self, value):
        return value - self.decay_factor * (self.millis_passed / 1000)

    def exponential_decay(self, value):
        return value * math.pow(self.decay_factor, self.millis_passed / 1000)