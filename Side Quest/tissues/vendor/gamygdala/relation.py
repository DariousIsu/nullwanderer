import math
from emotion import Emotion

'''
Class Relation
This is the class that represents a relation one agent has with other agents.
It's main role is to store and manage the emotions felt for a target agent (e.g angry at, or pity for).
Each agent maintains a list of relations, one relation for each target agent.
Params:
* target_name: The agent who is the target of the relation.
* like:  The relation [-1 and 1].
'''
class Relation:
    def __init__(self, target_name, like):
        self.agent_name = target_name
        self.like = like
        self.emotion_list = []

    def add_emotion(self, emotion):
        added = False
        for existing_emotion in self.emotion_list:
            if existing_emotion.name == emotion.name:
                existing_emotion.intensity += emotion.intensity
                added = True
                break
        
        if not added:
            # Copy on keep, we need to maintain a list of current emotions for the relation,
            # not a list of refs to the appraisal engine
            self.emotion_list.append(Emotion(emotion.name, emotion.intensity))

    def decay(self, gamygdala_instance):
        i = 0
        while i < len(self.emotion_list):
            new_intensity = gamygdala_instance.decay_function(self.emotion_list[i].intensity)
            # Bug fix (math.isclose)
            if math.isclose(new_intensity, 0.0, abs_tol=0.001):
                # This emotion has decayed below zero, we need to remove it
                del self.emotion_list[i]
            else:
                self.emotion_list[i].intensity = new_intensity
                i += 1