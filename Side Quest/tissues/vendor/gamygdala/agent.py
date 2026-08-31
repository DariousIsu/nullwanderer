import math
from emotion import Emotion
from relation import Relation

class Agent:
    def __init__(self, name):
        self.name = name
        self.goals = []
        self.current_relations = []
        self.internal_state = []
        self.gain = 1
        self.gamygdala_instance = None
        self.map_pad = {
            'distress': [-0.61, 0.28, -0.36],
            'fear': [-0.64, 0.6, -0.43],
            'hope': [0.51, 0.23, 0.14],
            'joy': [0.76, .48, 0.35],
            'satisfaction': [0.87, 0.2, 0.62],
            'fear-confirmed': [-0.61, 0.06, -0.32],
            'disappointment': [-0.61, -0.15, -0.29],
            'relief': [0.29, -0.19, -0.28],
            'happy-for': [0.64, 0.35, 0.25],
            'resentment': [-0.35, 0.35, 0.29],
            'pity': [-0.52, 0.02, -0.21],
            'gloating': [-0.45, 0.48, 0.42],
            'gratitude': [0.64, 0.16, -0.21],
            'anger': [-0.51, 0.59, 0.25],
            'gratification': [0.69, 0.57, 0.63],
            'remorse': [-0.57, 0.28, -0.34]
        }

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Goal Managament
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def add_goal(self, goal):
    	# no copy, cause we need to keep the ref,
	    # one goal can be shared between agents so that changes to this one goal are reflected in the emotions of all agents sharing the same goal
        self.goals.append(goal)

    def remove_goal(self, goalName):
        for i, goal in enumerate(self.goals):
            if goal.name == goalName:
                del self.goals[i]
                return True
        return False

    def has_goal(self, goal_name):
        return self.get_goal_by_name(goal_name) is not None

    def get_goal_by_name(self, goal_name):
        for goal in self.goals:
            if goal.name == goal_name:
                return goal
        return None

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    appraise
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def set_gain(self, gain):
        if gain <= 0 or gain > 20:
            print('Error: gain factor for appraisal integration must be between 0 and 20')
        else:
            self.gain = gain

    def appraise(self, belief):
        self.gamygdala_instance.appraise_agent(belief, self)

    def update_emotional_state(self, emotion):
        for internal_emotion in self.internal_state:
            if internal_emotion.name == emotion.name:
                # Appraisals simply add to the old value of the emotion
                # So repeated appraisals without decay will result in the sum of the appraisals over time
                # To decay the emotional state, call .decay(decay_function), or simply use the facilitating function in Gamygdala set_decay(time_ms).
                internal_emotion.intensity += emotion.intensity
                return

        # Copy on keep, we need to maintain a list of current emotions for the state, not a list of references to the appraisal engine
        self.internal_state.append(Emotion(emotion.name, emotion.intensity))

    def get_emotional_state(self, useGain=False):
        if useGain:
            gainState = []
            for internal_state in self.internal_state:
                gainEmo = (self.gain * internal_state.intensity) / (self.gain * internal_state.intensity + 1)
                gainState.append(Emotion(internal_state.name, gainEmo))
            return gainState
        else:
            return self.internal_state

    def print_emotional_state(self, use_gain):
        output = f"{self.name} feels "
        emotional_state = self.get_emotional_state(use_gain)
        emotion_strings = []

        for emotion in emotional_state:
            emotion_strings.append(f"{emotion.name.upper()} : {emotion.intensity:.2f}")
        
        if emotion_strings:
            output += ", ".join(emotion_strings)
            print(output)
    
    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    PAD processing
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def get_pad_state(self, use_gain):
        pad = [0, 0, 0]
        
        for internal_state in self.internal_state:
            for i in range(3):
                pad[i] += internal_state.intensity * self.map_pad[internal_state.name][i]
                
        if use_gain:
            for i in range(3):
                if pad[i] >= 0:
                    pad[i] = self.gain * pad[i] / (self.gain * pad[i] + 1)
                else:
                    pad[i] = -self.gain * pad[i] / (self.gain * pad[i] - 1)
            return pad

        else:
            return pad

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Relations management
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def update_relation(self, agent_name, like):
        if not self.has_relation_with(agent_name):
            # This relation does not exist, just add it.
            self.current_relations.append(Relation(agent_name, like))
        else:
            # The relation already exists, update it.
            for relation in self.current_relations:
                if relation.agent_name == agent_name:
                    relation.like = like
                    break

    def has_relation_with(self, agent_name):
        return self.get_relation(agent_name) is not None

    def get_relation(self, agent_name):
        for relation in self.current_relations:
            if relation.agent_name == agent_name:
                return relation
        return None

    def print_relations(self, agent_name=None):
        output = f"{self.name} has the following sentiments:\n   "
        found = False

        for i, relation in enumerate(self.current_relations):
            if agent_name is None or relation.agent_name == agent_name:
                emotion_str = " ".join(f"{emotion.name}({emotion.intensity:.2f})" for emotion in relation.emotion_list)
                if emotion_str:
                    output += emotion_str
                    found = True

            output += f" for {relation.agent_name}"
            if i < len(self.current_relations) - 1:
                output += ", and\n   "

        if found:
            print(output)

    '''
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    Decay 
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    '''
    def decay(self, gamygdala_instance):
        # Use a for loop with enumerate to iterate over internal states
        for i, state in enumerate(self.internal_state):
            new_intensity = gamygdala_instance.decay_function(state.intensity)
            
            if math.isclose(new_intensity, 0.0, abs_tol=0.001):
                del self.internal_state[i]
                if gamygdala_instance.debug:
                    print(f"Deleting {state.name.upper()}")
            else:
                state.intensity = new_intensity
                if gamygdala_instance.debug:
                    print(f"\r{state.name.upper()} intensity = {new_intensity:.2f}...      ", end='', flush=True)

        # Decay all current relations
        for relation in self.current_relations:
            relation.decay(gamygdala_instance)